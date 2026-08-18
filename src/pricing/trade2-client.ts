import type { Settings } from "../shared/settings";
import type { ItemDefences, ModFilter, ParsedItem, PseudoStat } from "../shared/types";
import { createPublicGggFetch, type GggFetch } from "./ggg-fetch";
import { modsOf } from "../shared/mods";
import { defencesOf, isLocalDefenceMod } from "../shared/defences";
import { mapFilterLabel, mapRowsOf } from "../shared/map-stats";
import { derivePseudoStatsFromMods, pseudoTotal } from "../shared/pseudo-stats";
import { TradeStatsMatcher } from "./trade-stats";
import { TradeSearchBudget } from "./trade-budget";

const API_BASE = "https://www.pathofexile.com/api/trade2";
const REALM = "poe2";
/** More than 10 ids in one fetch call is answered with `400 {"error":{"code":2,...}}`. */
const MAX_FETCH_IDS = 10;

/** GGG's `status` options. See `trade2.listingStatus` for what each one actually selects. */
export type ListingStatus = Settings["trade2"]["listingStatus"];

/**
 * How to name the listings a given `status` searched, for every message that reports finding none.
 *
 * Worth being pedantic about, because the old wording was wrong in a way that hid a real bug: it said
 * "online listings" for everything except `"any"`, which read as an online/offline distinction when
 * GGG's `status` is actually choosing between **instant buyout** and **in person**. A user reading
 * "no online listings" would go and check whether the seller was online, when the app had in fact
 * excluded every instantly-buyable listing on the site.
 */
export function listingsLabelFor(status: ListingStatus): string {
  switch (status) {
    case "securable":
      return "instant-buyout listings";
    case "available":
      return "instant-buyout or in-person listings";
    case "online":
      return "in-person listings from online sellers";
    case "onlineleague":
      return "in-person listings from online sellers in this league";
    case "any":
      return "listings";
  }
}

interface TradeListing {
  listing: {
    price: { amount: number; currency: string } | null;
  };
  /**
   * `extended.hashes` names the exact stat ids this listing carries, grouped by kind. It is the only
   * thing in the response that says *which* of a `count` search's filters a given listing satisfied.
   */
  item?: {
    extended?: {
      hashes?: Record<string, Array<[string, number[]]>>;
    };
  };
}

interface GggErrorBody {
  error?: { code: number; message: string };
}

/**
 * One mod as trade2 asks for it. `value` is omitted entirely for stats GGG indexes without a number,
 * and either bound inside it is omitted when it doesn't apply — never sent as null. See
 * `buildStatFilters` for why a null bound is worse than no bound.
 */
interface StatFilter {
  id: string;
  value?: { min?: number; max?: number };
}

/**
 * Bounds the user set for a mod line in the row editor, keyed by that mod's exact display text.
 * Empty on the automatic pricing path, where every mod is searched at its own roll.
 */
export type ModFilterMap = ReadonlyMap<string, { min: number | null; max: number | null }>;

/** null for anything that can't go in a search body — NaN and Infinity both serialise to `null`. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The row editor's per-mod bounds as `buildStatFilters` wants them.
 *
 * Sanitised rather than trusted, and here rather than at the IPC boundary because this file owns
 * what may reach GGG: these round-trip through `loot-cache.json`, so a hand-edited or half-written
 * cache arrives by exactly the same route a live click does. Negative bounds are *kept* — plenty of
 * mods roll negative and the stat templates match a leading minus.
 */
export function toModFilterMap(modFilters: readonly ModFilter[] | undefined): ModFilterMap {
  const map = new Map<string, { min: number | null; max: number | null }>();
  for (const entry of modFilters ?? []) {
    if (!entry || typeof entry.text !== "string" || entry.text === "") continue;
    const min = finiteOrNull(entry.min);
    let max = finiteOrNull(entry.max);
    // An inverted range matches nothing, and "no listings" for it is indistinguishable from "this
    // item has no market". Drop the ceiling and search the floor alone.
    if (max !== null && min !== null && max < min) max = null;
    map.set(entry.text, { min, max });
  }
  return map;
}

/**
 * `ItemDefences` keys to the ids GGG's `equipment_filters` group uses, confirmed against
 * `/api/trade2/data/filters`. That group is the *only* route to total armour — the `pseudo` stat
 * group publishes totals for life, ES, resistances and attributes, but nothing for armour.
 */
const DEFENCE_FILTER_IDS: Record<keyof ItemDefences, string> = {
  armour: "ar",
  evasion: "ev",
  energyShield: "es",
  ward: "ward"
};


/** One defence as trade2 asks for it: `{ id: "ar", min: 973 }` -> `"ar": { "min": 973 }`. */
interface DefenceFilter {
  id: string;
  min: number;
}

/** One rung's search result, held back until the ladder knows which rung is worth fetching. */
interface RungResult {
  /** Mods a listing had to share to appear here. */
  required: number;
  searchId: string;
  /** Ids GGG returned, price-ascending and capped at 100 however large `total` is. */
  ids: string[];
  total: number;
}

/** Outcome of one trade lookup. `reason` is user-facing text, shown in the row editor and logged. */
export interface TradeEstimate {
  /**
   * The **cheapest** convertible listing in the sample — what you could undercut into today, which
   * is the number someone deciding whether to list an item actually wants.
   *
   * Read `medianChaosValue` beside it: the two together say how thin the floor is. A floor far
   * below the median of the same five listings is one optimistic seller, not a market.
   */
  chaosValue: number | null;
  /**
   * The median of the same sampled window `chaosValue` is the floor of. Carried rather than chosen
   * because it answers a different question — the floor is what you can sell into now, the median
   * is what the cheap end is actually asking. null whenever there is no price.
   */
  medianChaosValue: number | null;
  /** Why there is no value. null when `chaosValue` is set. */
  reason: string | null;
  /** How many listings both figures were taken over — the sample, not the whole match set. */
  listings: number;
  /** How many online listings the search matched in total, which the sample is drawn from. */
  matches: number;
  /**
   * GGG's id for the search this price came from — the rung that was actually fetched, not the
   * stricter ones the ladder passed over, so opening it shows the listings the median was taken
   * over rather than a query that returned nothing.
   *
   * Absent whenever there was no successful search to point at. Feed it to `tradeSearchUrl`.
   */
  searchId?: string;
  /** How many of the item's mods the priced listings were required to share. */
  matchedMods: number;
  /** How many mod filters the item produced. `matchedMods < totalMods` means the search relaxed. */
  totalMods: number;
  /**
   * What each rung the ladder tried actually matched, strictest first. Kept so a caller can
   * say *why* a stricter rung was passed over — "nothing carries all four mods" and "one listing
   * does, which is too thin to be a price" call for different things from the user.
   *
   * `filters` is how many stat filters that rung sent, and it is what separates the two ladder axes:
   * `required: 4, filters: 5` relaxed the threshold, while `required: 4, filters: 4` dropped a
   * low-tier mod and still demanded the rest. Without it the two are indistinguishable.
   */
  rungs: Array<{ required: number; total: number; filters: number }>;
  /**
   * The defence floors the search was constrained to, e.g. `[{ id: "ar", min: 973 }]`. Empty when
   * the item has no defences, or when `trade2.useDefenceFilters` is off.
   */
  defences: DefenceFilter[];
  /**
   * Every rung came back empty with those floors applied, so the search was retried once without
   * them. The price is a looser comparable than the mod count alone suggests — it came from items
   * of this base sharing these mods, at *any* armour.
   */
  defencesDropped: boolean;
  /**
   * The aggregates the search was constrained to, and the mods that fed each. Empty when the item has
   * none, when `trade2.usePseudoFilters` is off, or when they were dropped by the retry below.
   *
   * Carried rather than folded into `totalMods` on purpose: three resistance rolls searched as one
   * total is why five mods produced three filters, and that is worth saying out loud rather than
   * leaving as an unexplained discrepancy in the counts.
   */
  pseudoStats: PseudoStat[];
  /**
   * Every rung came back empty with the aggregates applied, so the search was retried once without
   * them — the price ignores this item's resistance/life totals entirely.
   */
  pseudoDropped: boolean;
  /**
   * A waystone's reward floors matched nothing, so the search fell back to base type alone — which
   * for a waystone means "every other waystone of this tier", since its affixes are never searched.
   */
  mapDropped: boolean;
  /**
   * How many of the sampled listings carried each of the item's mods.
   *
   * Not "the mods that were used" — a `count` search asks for at least N of M, and different
   * listings satisfy different subsets, so no such set exists. This is the honest version of that
   * question: how often each mod turned up among the listings the price came from.
   */
  statCoverage: Array<{ text: string; listings: number }>;
  /** The listings `statCoverage` was counted over — the denominator of every count above. */
  coverageSample: number;
  /**
   * The mod lines the tier ladder removed to reach this price, worst affix first.
   *
   * Unlike `statCoverage` this **is** a real set of mods, and the distinction is the whole point of
   * the drop axis. A `count` rung asks for "at least N of M" and different listings satisfy different
   * subsets, so nothing there can name the mods a price rests on; a drop rung requires *all* of a
   * named subset, so the mods left out of it are known exactly. That is what lets the row editor
   * reopen with the surviving mods ticked.
   *
   * Empty whenever the price came from a count rung, which is every item with no tier data.
   */
  autoDroppedMods: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noPrice(reason: string): TradeEstimate {
  return {
    chaosValue: null,
    medianChaosValue: null,
    reason,
    listings: 0,
    matches: 0,
    matchedMods: 0,
    totalMods: 0,
    rungs: [],
    defences: [],
    defencesDropped: false,
    pseudoStats: [],
    pseudoDropped: false,
    mapDropped: false,
    statCoverage: [],
    coverageSample: 0,
    autoDroppedMods: []
  };
}

/** "21+ Item Rarity, 76+ Waystone Drop Chance" — how a waystone's reward floors are named. */
export function describeMapFilters(filters: DefenceFilter[]): string {
  return filters.map((filter) => `${filter.min}+ ${mapFilterLabel(filter.id)}`).join(", ");
}

/** "973+ Armour, 216+ Evasion" — how a defence constraint is named in a message. */
export function describeDefences(defences: DefenceFilter[]): string {
  const labels: Record<string, string> = { ar: "Armour", ev: "Evasion", es: "Energy Shield", ward: "Ward" };
  return defences.map((filter) => `${filter.min}+ ${labels[filter.id] ?? filter.id}`).join(", ");
}

/**
 * "74+ total Elemental Resistance (from 3 mods)" — how an aggregate constraint is named.
 *
 * The mod count is the part that explains itself: it says which of the item's mods stopped being
 * searched individually, so a reader can reconcile "5 mods" with the smaller filter count.
 */
export function describePseudo(stats: PseudoStat[], filters: StatFilter[]): string {
  const minById = new Map(filters.map((filter) => [filter.id, filter.value?.min]));
  return stats
    .map((stat) => {
      const min = minById.get(stat.id);
      const floor = min === undefined ? "any" : `${min}+`;
      return `${floor} ${stat.label} (from ${stat.contributors.length} mods)`;
    })
    .join(", ");
}

/** A settled "no price" - retrying would produce the same answer. */
function definitive(reason: string): { estimate: TradeEstimate; transient: boolean } {
  return { estimate: noPrice(reason), transient: false };
}

/**
 * How many of an item's mods a listing must match to count as comparable.
 *
 * Requiring *all* of them (GGG's `stats` type `"and"`) is the obvious reading of "price this item",
 * and it does not work. Measured against the live API for one Sapphire Ring base:
 *
 * | query | listings |
 * |---|---|
 * | base type only | 7673 |
 * | 2 mods, all required | 14 |
 * | 5 mods, all required | **0** |
 * | 5 mods, 3 required (`count`) | 44 |
 *
 * A typical rare carries four to six explicit mods, so `"and"` returns nothing for the ordinary
 * case and every rare falls through to unpriced. `count` with a minimum is what makes this usable.
 *
 * The tradeoff is real and worth being clear-eyed about: this stops pricing *this exact item* and
 * starts pricing *items broadly like it*, which biases low — a listing matching 3 of 5 mods may be
 * worse on the other two, and results are taken from the cheap end. For a running loot total an
 * approximate number beats a blank one, but don't read a trade2 price as an appraisal.
 *
 * One- and two-mod items keep every filter (the floor of 2, capped at `count`): they are already
 * specific enough to match, and halving them would throw away the only signal there is.
 */
export function requiredModMatches(count: number, ratio: number): number {
  if (count === 0) return 0;
  return Math.min(count, Math.max(2, Math.ceil(count * ratio)));
}

/**
 * The mod-count thresholds to try, **strictest first**: `[4, 3, 2]` for a four-mod rare.
 *
 * A search for every mod prices *this item*; `requiredModMatches()`'s floor prices *items broadly
 * like it*. Trying the strict end first therefore costs nothing when it hits — an exact match is
 * both the better price and the first thing asked for — and only descends when it comes back empty.
 *
 * Since `count >= n` is a superset of `count >= n+1`, every step down can only add listings, and the
 * last rung is exactly the query this used to send alone. So the ladder can never price something
 * the old single search would have priced better, and never leaves an item unpriced that the old
 * one would have priced.
 *
 * The cost is one extra *request* per rung that misses, against a budget GGG enforces per IP, so
 * `maxSteps` caps how many are spent. When the cap bites, the strictest rungs are kept and the floor
 * is always kept: dropping the floor would turn priced items into unpriced ones, which is the one
 * regression that isn't worth any amount of precision.
 */
export function modLadder(count: number, ratio: number, maxSteps: number): number[] {
  const floor = requiredModMatches(count, ratio);
  const stricter: number[] = [];
  for (let required = count; required > floor; required--) stricter.push(required);

  const room = Math.max(1, Math.floor(maxSteps)) - 1;
  return [...stricter.slice(0, Math.max(0, room)), floor];
}

/**
 * The stat filters to remove one at a time, **worst affix first**, when the full mod set finds no
 * market. Returns stat ids in drop order; an empty array means nothing may be dropped.
 *
 * This is the ladder's *other* axis, and the two ask genuinely different questions. `modLadder()`
 * keeps every filter and relaxes the `count` threshold, so "4 of 5" lets a listing miss **any** one
 * mod — including the T1 roll that is the entire reason the item is worth anything. Dropping a named
 * filter instead and requiring all the survivors asks for a specific, weaker item, which is both
 * closer to how a player would narrow the search by hand and — because the surviving set is known
 * rather than "whichever 4 a given listing happened to have" — the only form of relaxation whose
 * result can be reported back as a set of mods. `statCoverage` exists precisely because the `count`
 * group makes that impossible; see its note in `types.ts`.
 *
 * Three rules, all conservative in the same direction — a filter is dropped only when there is
 * positive evidence it is the weak one:
 *
 * - **A filter is ranked by its *best* contributor, not its worst.** Filters are summed per stat id
 *   (see `buildStatFilters`), so one can be fed by several mod lines, and dropping it drops all of
 *   them. Ranking by the worst would let a T5 roll carry a T1 off the search with it.
 * - **Unknown tier is never droppable.** PoE2 only prints `(Tier: N)` under Advanced Item
 *   Descriptions, so an item captured without it yields an empty array and the caller falls straight
 *   back to `modLadder()` alone. That degradation is the whole reason this returns ids rather than
 *   throwing or guessing: no tier data means no behaviour change at all.
 * - **Ties keep the item's own order**, so the same item always produces the same ladder and a
 *   reported mod set is reproducible.
 *
 * `tierThreshold` is the *worst-or-equal* bound: at 3, tiers 3 and up may go and T1/T2 never do.
 */
export function droppableFilters(
  order: Array<{ statId: string; tiers: Array<number | null | undefined> }>,
  tierThreshold: number
): string[] {
  const ranked: Array<{ statId: string; best: number; index: number }> = [];

  for (const [index, filter] of order.entries()) {
    // No contributors means nothing is known about it, which is the unknown case rather than a
    // vacuously droppable one — `Math.min()` of nothing is Infinity and would rank it worst of all.
    if (filter.tiers.length === 0) continue;
    if (filter.tiers.some((tier) => typeof tier !== "number")) continue;

    const best = Math.min(...(filter.tiers as number[]));
    if (best < tierThreshold) continue;
    ranked.push({ statId: filter.statId, best, index });
  }

  // Worst affix first, so the search sheds the least of the item's value per rung.
  ranked.sort((a, b) => b.best - a.best || a.index - b.index);
  return ranked.map((entry) => entry.statId);
}

/**
 * The full sequence of searches one lookup may send, strictest first — the two ladder axes composed.
 *
 * With nothing droppable this is **exactly** `modLadder()` over the whole filter set, rung for rung,
 * which is what makes the tier feature free for players who don't run Advanced Item Descriptions: no
 * tier data means `dropOrder` is empty means today's behaviour, byte for byte.
 *
 * With mods to drop the sequence becomes:
 *
 * 1. every filter, all required — "price *this* item", and the first thing worth asking;
 * 2. one rung per dropped filter, still requiring all the survivors, worst affix first;
 * 3. `modLadder()`'s thresholds over whatever survived.
 *
 * Step 3 is not optional. A drop rung requires *all* of a smaller set, so it is stricter than the
 * count rung at the same number — `all of these 4` is a subset of `any 4 of 5` — and a set of four
 * mods nobody has listed together stays unmatched however many of the weak ones come off. The count
 * tail is the query that priced things before any of this existed, so keeping it last is what
 * guarantees this can never leave an item unpriced that the old ladder would have priced.
 *
 * At least one filter always survives: dropping to nothing is a base-type-only search, which the
 * no-match path already words for itself and which no amount of tier information makes worth a slot.
 */
export function searchRungs<F extends { id: string }>(
  filters: F[],
  dropOrder: string[],
  options: { ratio: number; maxLadderSteps: number; maxDropSteps: number }
): Array<{ filters: F[]; required: number; dropped: string[] }> {
  const countTail = (subset: F[], dropped: string[]) =>
    modLadder(subset.length, options.ratio, options.maxLadderSteps).map((required) => ({
      filters: subset,
      required,
      dropped
    }));

  const maxDrops = Math.min(
    dropOrder.length,
    Math.floor(options.maxDropSteps),
    // Never empty the set — see above.
    filters.length - 1
  );
  if (maxDrops < 1) return countTail(filters, []);

  const rungs: Array<{ filters: F[]; required: number; dropped: string[] }> = [
    { filters, required: filters.length, dropped: [] }
  ];

  for (let drops = 1; drops <= maxDrops; drops++) {
    const removed = dropOrder.slice(0, drops);
    const subset = filters.filter((filter) => !removed.includes(filter.id));
    rungs.push({ filters: subset, required: subset.length, dropped: removed });
  }

  const last = rungs[rungs.length - 1];
  // The tail's strictest threshold is "all of the survivors", which is the rung just pushed — so it
  // is dropped here rather than sent twice at the cost of a request against GGG's per-IP budget.
  return [...rungs, ...countTail(last.filters, last.dropped).filter((rung) => rung.required < last.required)];
}

/**
 * Which slice of the price-ascending search results to actually fetch a price from: the **cheapest
 * `size`**.
 *
 * This reports the *market floor* — what the current undercutters are asking — rather than what the
 * item is worth. That is a deliberate choice and the number it produces is genuinely lower, often by
 * a lot. Measured on a real four-mod Ruby jewel (236 matching online listings; GGG's search returns
 * at most the 100 cheapest ids however many matched):
 *
 * | ids taken | prices seen |
 * |---|---|
 * | 0-4 (what this does) | `1 exalted`, straight through |
 * | 45-54 (the middle, which this used to take) | 29, 29, 30, 30, 30, 30, 30, 33, 40, 40 exalted |
 * | 90-99 (the top) | 5 chaos, 500 exalted, seven `1 divine` |
 *
 * Sellers of that jewel were asking ~30 exalted; this prices it at 1. **Both numbers are real** —
 * PoE2's cheap end is a wall of dump listings, and this is now measuring that wall on purpose,
 * because a floor is what you can actually sell into today rather than what the item is nominally
 * worth. Don't "fix" the low readings by moving the window back to the middle without asking: that
 * changes what the number means, not just its accuracy.
 *
 * The bias compounds with two others in the same direction — the ladder settling on a rung looser
 * than every mod, and the 100-id search cap.
 */
export function priceSample<T>(results: T[], size: number): T[] {
  return results.slice(0, size);
}

/**
 * Prices Rare items off GGG's PoE2 trade API — the same `search` -> `fetch` pair the trade site
 * itself calls. poe.ninja publishes no rare prices (too mod-dependent), so this is the only
 * automatic source for the bulk of what actually drops.
 *
 * **No authentication is involved, and none is possible.** This is worth spelling out because an
 * earlier version of this file implemented OAuth 2.0 + PKCE against `service:psapi` and was
 * therefore permanently inert, on the belief that trade search required an OAuth client id GGG
 * would not issue. Two different APIs were being conflated:
 *
 * - GGG's *documented OAuth API* (profile, stashes, characters, league accounts) does require a
 *   registered client, registration is closed, and it documents no trade-search endpoint or scope.
 *   Nothing here uses it.
 * - `www.pathofexile.com/api/trade2/*`, used below, answers anonymous requests and rate-limits by
 *   IP. It is undocumented but openly served, and it is what every third-party trade tool uses.
 *
 * Two obligations come with that, both handled: requests carry an app-identifying `User-Agent` via
 * `createPublicGggFetch`, and searches are budgeted by `TradeSearchBudget` on top of the reactive
 * `GggRateLimiter`, because tripping GGG's limits repeatedly is what gets an IP banned.
 */
export class Trade2Client {
  private readonly gggFetch: GggFetch;
  private readonly statsMatcher: TradeStatsMatcher;
  private readonly budget: TradeSearchBudget;

  constructor(
    private readonly settings: Settings,
    gggFetch: GggFetch = createPublicGggFetch(settings)
  ) {
    this.gggFetch = gggFetch;
    this.statsMatcher = new TradeStatsMatcher(this.gggFetch);
    this.budget = new TradeSearchBudget(
      [
        { max: settings.trade2.maxSearchesPerWindow, windowMs: settings.trade2.windowMs },
        { max: settings.trade2.maxSearchesPerLongWindow, windowMs: settings.trade2.longWindowMs }
      ],
      settings.trade2.minSearchIntervalMs
    );
  }

  /** Whether lookups are switched on at all. The only remaining kill switch — there is no login. */
  get isAvailable(): boolean {
    return this.settings.trade2.enabled;
  }

  /** Which listings were counted, so callers can word "no listings" without contradicting the query. */
  get listingStatus(): ListingStatus {
    return this.settings.trade2.listingStatus;
  }

  /**
   * How to name the listings that *were* searched, matching the query exactly.
   *
   * Never a bare "no listings": every option here excludes something, and a message that doesn't say
   * which one is the reason the app looks wrong next to the trade site. "No instant-buyout listings"
   * and "no listings" are different claims, and only one of them is ever true.
   */
  private get listingsLabel(): string {
    return listingsLabelFor(this.listingStatus);
  }

  /**
   * Estimates a chaos-equivalent value for a rare item from live listings. `ignoredMods` excludes
   * specific mod lines (the row editor's checkboxes) from the search; the rest are matched against
   * GGG's public stat reference and searched as "at least this roll" filters. If none of the mods
   * can be matched, this falls back to a base-type-only search rather than failing outright.
   * `toChaos` converts a listing's currency (e.g. "divine") into chaos.
   *
   * `modFilters` overrides the roll a given mod is searched at, and `pseudoBounds` does the same for
   * a derived aggregate, keyed by pseudo stat id. Both default to empty, which is the automatic
   * pricing path — every mod at its own number and every aggregate at `pseudoMinRatio` of the item's
   * own total, exactly as this behaves with nobody editing anything.
   */
  async estimateRareValue(
    item: ParsedItem,
    ignoredMods: Set<string>,
    toChaos: (amount: number, currency: string) => number | null,
    modFilters: ModFilterMap = new Map(),
    pseudoBounds: ModFilterMap = new Map(),
    mapBounds: ModFilterMap = new Map()
  ): Promise<TradeEstimate> {
    if (!this.settings.trade2.enabled) {
      return noPrice("trade2 lookups are switched off (trade2.enabled is false in settings)");
    }
    if (!item.baseType) {
      return noPrice("no base type to search on — trade2 searches by base type plus mod filters");
    }

    // GGG's own hosts blip: a real capture hit `HTTP 502` on trade2 and on the currency exchange
    // in the same second. Without a retry that momentary outage stores the item unpriced forever,
    // which reads exactly like "this rare has no market" and isn't. Only 5xx and outright network
    // failures are retried — a 429 means the budget below was already too generous, and sleeping
    // out GGG's minutes-long Retry-After would stall the whole pricing queue.
    let lastTransient: string | null = null;

    for (let attempt = 0; attempt <= this.settings.trade2.maxTransientRetries; attempt++) {
      const waitMs = this.budget.reserve();
      if (waitMs === null) {
        const seconds = Math.ceil(this.budget.cooldownMs() / 1000);
        // A spent budget mid-retry shouldn't hide what actually went wrong first.
        if (lastTransient) return noPrice(`${lastTransient}; no budget left to retry`);
        return noPrice(
          `trade2 search budget spent (${this.settings.trade2.maxSearchesPerWindow} per ` +
            `${Math.round(this.settings.trade2.windowMs / 60000)}min; GGG rate-limits by IP) - ` +
            `retry in ~${seconds}s with the row's Reprice button`
        );
      }
      // Doubles as the retry backoff: the budget already spaces searches by minSearchIntervalMs.
      if (waitMs > 0) await sleep(waitMs);

      const { estimate, transient } = await this.attempt(
        item,
        ignoredMods,
        toChaos,
        modFilters,
        pseudoBounds,
        mapBounds
      );
      if (!transient) return estimate;

      lastTransient = estimate.reason;
      if (attempt < this.settings.trade2.maxTransientRetries) {
        console.warn(`[trade2] ${estimate.reason} - retrying`);
      }
    }

    return noPrice(
      `${lastTransient} (gave up after ${this.settings.trade2.maxTransientRetries + 1} attempts) - ` +
        "retry later with the row's Reprice button"
    );
  }

  /** One search+fetch round trip. `transient` marks failures worth retrying. */
  private async attempt(
    item: ParsedItem,
    ignoredMods: Set<string>,
    toChaos: (amount: number, currency: string) => number | null,
    modFilters: ModFilterMap,
    pseudoBounds: ModFilterMap,
    mapBounds: ModFilterMap
  ): Promise<{ estimate: TradeEstimate; transient: boolean }> {
    try {
      return await this.search(item, ignoredMods, toChaos, modFilters, pseudoBounds, mapBounds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A thrown fetch is DNS/socket/TLS — the network, not a rejected query.
      return { estimate: noPrice(`trade2 request failed: ${message}`), transient: true };
    }
  }

  /**
   * Walks `modLadder()` from "every mod" downwards and prices off the strictest rung that describes
   * an actual market, then fetches **once** for whichever rung won.
   *
   * "Strictest that matched anything" is the wrong stopping rule, and the item that prompted this
   * shows why: a real four-mod Ruby jewel had exactly **one** online listing carrying all four mods,
   * at 30 chaos, while eleven listings shared three of them and ran 1-500 exalted. A median over one
   * listing is that listing, so the exact-match rung would have reported one stranger's asking price
   * as the item's value — a different way of being wrong from the market floor this replaced, not a
   * better one. A rung has to clear `minListingsForMatch` to be taken at face value.
   *
   * Descending rungs are supersets, so the last non-empty one always has the most listings; that's
   * what `best` ends up holding when nothing clears the bar, and it's the same query as before the
   * ladder existed. The caller reserved the budget slot for the first rung, each step down spends
   * another, and running out stops the descent rather than waiting out the window — with whatever
   * `best` already holds, since a usable rung in hand beats reporting no market at all.
   */
  private async search(
    item: ParsedItem,
    ignoredMods: Set<string>,
    toChaos: (amount: number, currency: string) => number | null,
    modFilters: ModFilterMap,
    pseudoBounds: ModFilterMap,
    mapBounds: ModFilterMap
  ): Promise<{ estimate: TradeEstimate; transient: boolean }> {
    const defenceFilters = this.buildDefenceFilters(item);
    const mapFilters = this.buildMapFilters(item, mapBounds);

    // A waystone is searched on its reward block alone — see buildMapFilters for the measurements.
    // The affixes and any aggregate derived from them are dropped wholesale rather than folded
    // mod-by-mod, because collectively they *are* the reward block: there is nothing left over that
    // a stat filter could ask for without re-pinning rolls nobody else has.
    const searchOnRewards = mapFilters.length > 0;
    const pseudoStats = searchOnRewards ? [] : this.buildPseudoStats(item, ignoredMods);
    const pseudoFilters = this.buildPseudoFilters(pseudoStats, pseudoBounds);
    const foldedIntoPseudo = new Set(
      pseudoStats.flatMap((stat) => stat.contributors.map((contributor) => contributor.text))
    );
    const built = searchOnRewards
      ? {
          filters: [],
          modsByStat: new Map<string, string[]>(),
          tiersByStat: new Map<string, Array<number | null | undefined>>()
        }
      : await this.buildStatFilters(
          item,
          ignoredMods,
          defenceFilters.length > 0,
          modFilters,
          foldedIntoPseudo
        );
    const statFilters = built.filters;
    const trade2 = this.settings.trade2;

    // Which filters the ladder may shed, worst affix first. Empty whenever the item carries no tier
    // information — i.e. the player isn't running Advanced Item Descriptions — which collapses the
    // whole thing back to the count ladder alone. See `droppableFilters`.
    const dropOrder = trade2.useModDropLadder
      ? droppableFilters(
          statFilters.map((filter) => ({
            statId: filter.id,
            tiers: built.tiersByStat.get(filter.id) ?? []
          })),
          trade2.modDropTierThreshold
        )
      : [];

    // Deliberately over `statFilters` alone. The pseudo group is always required rather than being
    // one more thing a listing may or may not share, so it must not shift the thresholds the ladder
    // relaxes through — nor the counts reported from them.
    const ladder = searchRungs(statFilters, dropOrder, {
      ratio: trade2.minModMatchRatio,
      maxLadderSteps: trade2.maxModLadderSearches,
      maxDropSteps: trade2.maxModDropSearches
    });

    let best: RungResult | null = null;
    let bestDropped: string[] = [];
    const rungs: Array<{ required: number; total: number; filters: number }> = [];
    let budgetStopped = false;

    // An item whose only matchable mods were defence mods leaves no stat filters and an empty
    // ladder — but "this base with at least this much armour" is a real query and worth sending, so
    // it gets one rung at a threshold of zero rather than falling through to "no listings for base
    // type", which would be a flat lie about a search that was never run.
    const rungsToTry =
      ladder.length > 0 ? ladder : [{ filters: statFilters, required: 0, dropped: [] as string[] }];

    for (const [step, candidate] of rungsToTry.entries()) {
      if (step > 0 && !(await this.spendBudgetSlot())) {
        budgetStopped = true;
        break;
      }

      const rung = await this.searchRung(
        item,
        candidate.filters,
        candidate.required,
        defenceFilters,
        pseudoFilters,
        mapFilters
      );
      if ("failure" in rung) return rung.failure;
      rungs.push({ required: candidate.required, total: rung.total, filters: candidate.filters.length });

      if (rung.total > 0) {
        best = rung;
        bestDropped = candidate.dropped;
      }
      if (rung.total >= trade2.minListingsForMatch) break;
    }

    // Nothing at any threshold with the derived aggregates applied. They're the newer and more
    // speculative constraint of the two, so they come off first — and unlike the mod filters, the
    // ladder can't loosen them, since the pseudo group is always required.
    const looseRung = rungsToTry[rungsToTry.length - 1];
    let pseudoDropped = false;
    if (!best && !budgetStopped && pseudoFilters.length > 0) {
      if (await this.spendBudgetSlot()) {
        console.log(
          `[trade2] "${item.baseType}" no listings with ${describePseudo(pseudoStats, pseudoFilters)} - ` +
            "retrying without the aggregate constraint"
        );
        const rung = await this.searchRung(
          item,
          looseRung.filters,
          looseRung.required,
          defenceFilters,
          [],
          mapFilters
        );
        if ("failure" in rung) return rung.failure;
        if (rung.total > 0) {
          best = rung;
          bestDropped = looseRung.dropped;
          pseudoDropped = true;
        }
      } else {
        budgetStopped = true;
      }
    }

    // Nothing at any threshold *with* the defence floors either. Retry the loosest rung once without
    // them before giving up: that query is exactly what this sent before defence filters existed, so
    // it can only find listings the old code would also have found — it can never invent a market.
    // The extra request is only ever spent on an item that was otherwise about to be stored unpriced.
    //
    // The aggregates stay off here rather than coming back: the rung above already established they
    // find nothing alongside the defence floors, so re-sending them would spend the request on a
    // query that is a subset of one that just failed.
    let defencesDropped = false;
    if (!best && !budgetStopped && defenceFilters.length > 0) {
      if (await this.spendBudgetSlot()) {
        console.log(
          `[trade2] "${item.baseType}" no listings with ${describeDefences(defenceFilters)} - ` +
            "retrying without the defence constraint"
        );
        const rung = await this.searchRung(item, looseRung.filters, looseRung.required, [], [], mapFilters);
        if ("failure" in rung) return rung.failure;
        if (rung.total > 0) {
          best = rung;
          bestDropped = looseRung.dropped;
          defencesDropped = true;
          pseudoDropped = pseudoFilters.length > 0;
        }
      } else {
        budgetStopped = true;
      }
    }

    // And the same one more time for a waystone's reward floors. Last of the three because it is the
    // only constraint such an item has — with the affixes deliberately not searched, dropping this
    // leaves nothing but the base type, which prices a T15 against every other T15 regardless of what
    // it rolls. Worth doing rather than storing unpriced, but the caller has to be told.
    let mapDropped = false;
    if (!best && !budgetStopped && mapFilters.length > 0) {
      if (await this.spendBudgetSlot()) {
        console.log(
          `[trade2] "${item.baseType}" no listings with ${describeMapFilters(mapFilters)} - ` +
            "retrying on base type alone"
        );
        const rung = await this.searchRung(item, looseRung.filters, looseRung.required, defenceFilters, [], []);
        if ("failure" in rung) return rung.failure;
        if (rung.total > 0) {
          best = rung;
          bestDropped = looseRung.dropped;
          mapDropped = true;
        }
      } else {
        budgetStopped = true;
      }
    }

    // Named in every no-match message: without it the text blames the mods for a miss the armour
    // floor or an aggregate may well have caused, and points the user at unticking mods that were
    // never the problem.
    const constraints = [
      ...(defenceFilters.length > 0 ? [describeDefences(defenceFilters)] : []),
      ...(pseudoFilters.length > 0 ? [describePseudo(pseudoStats, pseudoFilters)] : []),
      ...(mapFilters.length > 0 ? [describeMapFilters(mapFilters)] : [])
    ];
    const withDefences = constraints.length > 0 ? ` with ${constraints.join(" and ")}` : "";

    // Each rung as "required/searched", since the ladder now varies both numbers: "4/5" is four of
    // the item's five mods, while "4/4" is all four left after a weak one was dropped. Reporting the
    // threshold alone would make those two searches indistinguishable in the log.
    const lastRung = rungs[rungs.length - 1];
    const triedLabel = rungs.map((rung) => `${rung.required}/${rung.filters}`).join(", ");

    if (!best && budgetStopped) {
      // Distinct from "nothing matches": the looser rungs that would have priced this were never
      // sent, so the row's Reprice really will find something once the window refills.
      return definitive(
        `no ${this.listingsLabel} match this ${item.baseType}${withDefences} on ` +
          `${lastRung?.required ?? 0} or more of its ${lastRung?.filters ?? statFilters.length} ` +
          `searched mods, and the search budget ran out before trying fewer - retry in ` +
          `~${Math.ceil(this.budget.cooldownMs() / 1000)}s with the row's Reprice button`
      );
    }

    if (!best) {
      // Naming the whole range matters: a message about the floor alone reads as though a stricter
      // search was what failed, when a stricter search is a subset of one that already matched
      // nothing. This is the "why not just require all the mods?" question, answered in the log.
      //
      // By here the defence floors have already been retried without, so they are not what failed —
      // hence no `withDefences` on these two. The base genuinely has no market at these rolls.
      return definitive(
        statFilters.length > 0
          ? `no ${this.listingsLabel} match this ${item.baseType} on ${lastRung?.required ?? 0} or ` +
              `more of its ${statFilters.length} mods at these rolls ` +
              `(tried required/searched ${triedLabel}) - ` +
              'press Edit on the row, untick the rare mods, then "Reprice via trade"'
          : `no ${this.listingsLabel} for base type "${item.baseType}"${withDefences}`
      );
    }

    // Back from stat ids to the mod lines the user sees, which is what the row editor keys on. One
    // dropped filter can name several lines — the hybrid affix case — and all of them left the search
    // together, so all of them are reported as dropped.
    const droppedMods = bestDropped.flatMap((statId) => built.modsByStat.get(statId) ?? []);
    if (droppedMods.length > 0) {
      console.log(
        `[trade2] "${item.baseType}" priced after dropping ${droppedMods.length} low-tier mod(s): ` +
          droppedMods.join("; ")
      );
    }

    return this.priceFromRung(
      best,
      statFilters.length,
      rungs,
      defencesDropped ? [] : defenceFilters,
      defencesDropped,
      toChaos,
      pseudoDropped ? [] : pseudoStats,
      pseudoDropped,
      mapDropped,
      built.modsByStat,
      droppedMods
    );
  }

  /** Spends one search slot, waiting out the configured spacing. false when the budget is gone. */
  private async spendBudgetSlot(): Promise<boolean> {
    const waitMs = this.budget.reserve();
    if (waitMs === null) return false;
    if (waitMs > 0) await sleep(waitMs);
    return true;
  }

  /**
   * The item's displayed defences as `equipment_filters`, each floored to a fraction of the item's
   * own total. Empty when the item has none, or the feature is switched off.
   *
   * This is what makes a rare armour searchable at all. GGG indexes the *total* — the number the
   * game prints, with every local mod and quality already in it — so asking for "this base with at
   * least this much armour" finds the market, while asking for the exact rolls of the two mods that
   * produced it finds nobody. A real Soldier Cuirass returned 0 listings on all its mods and 0 on
   * all-but-one, purely because `+N to Armour` and `N% increased Armour` were pinned to its rolls.
   *
   * `min` sits below the item's own value (`defenceMinRatio`) rather than at it: at parity the only
   * matches are items strictly better than this one, and a median over those prices something the
   * item isn't. It also absorbs the quality skew — GGG indexes these "including maximum quality"
   * while the clipboard prints them at the item's *current* quality, and separating the base value
   * from `increased%` to correct that needs a base-item table this app doesn't have.
   */
  /**
   * A waystone's printed reward totals as `map_filters`, each floored to a fraction of its own value.
   * Empty for anything that isn't a waystone, or when the feature is switched off.
   *
   * This is what makes a rare waystone priceable at all, and more starkly than the defence filters
   * did for armour. On the capture that prompted it, `Ghost Frontier`, the six affixes are all
   * monster-difficulty mods — Poison chance, Stun Buildup, Extra Fire — and no listing carried that
   * combination: 0 at six of six, 0 at five, 118 at three. Its reward block matched **3453**. The
   * rewards are what a buyer is choosing between; the affixes are just how the game got there, which
   * is why `buildStatFilters` is skipped entirely rather than having mods folded out of it.
   */
  private buildMapFilters(item: ParsedItem, bounds: ModFilterMap): DefenceFilter[] {
    if (!this.settings.trade2.useMapFilters) return [];

    const ratio = this.settings.trade2.mapMinRatio;

    return mapRowsOf(item)
      .map((row) => {
        const override = bounds.get(row.id);
        return { id: row.id, min: override?.min ?? Math.floor(row.value * ratio) };
      })
      .filter((filter) => filter.min > 0);
  }

  private buildDefenceFilters(item: ParsedItem): DefenceFilter[] {
    if (!this.settings.trade2.useDefenceFilters) return [];

    const defences = defencesOf(item);
    const ratio = this.settings.trade2.defenceMinRatio;

    return (Object.keys(DEFENCE_FILTER_IDS) as Array<keyof ItemDefences>)
      .filter((key) => defences[key] !== null && defences[key]! > 0)
      .map((key) => ({ id: DEFENCE_FILTER_IDS[key], min: Math.floor(defences[key]! * ratio) }))
      .filter((filter) => filter.min > 0);
  }

  /**
   * The aggregate stats this item's mods add up to, as GGG's pseudo group indexes them.
   *
   * Empty when switched off, and an aggregate is skipped when its id is in `ignoredMods` — the row
   * editor's pseudo rows untick into the same list the mod rows do, which is safe because a pseudo id
   * (`pseudo.pseudo_total_life`) can never collide with a mod line. Unticking a *contributor* needs
   * no special handling: it simply isn't passed in here, and an aggregate left with fewer than two
   * contributors stops being derived at all, handing its mods back to the ordinary stat filters.
   */
  private buildPseudoStats(item: ParsedItem, ignoredMods: Set<string>): PseudoStat[] {
    if (!this.settings.trade2.usePseudoFilters) return [];

    return derivePseudoStatsFromMods(
      modsOf(item).filter((mod) => !ignoredMods.has(mod.text)),
      defencesOf(item)
    ).filter((stat) => !ignoredMods.has(stat.id));
  }

  /**
   * The derived aggregates as trade2 stat filters, floored below the item's own total.
   *
   * `pseudoMinRatio` is below 1 for the reason `defenceMinRatio` is: at parity the only matches are
   * items strictly better than this one, and a median over those prices something the item isn't.
   */
  private buildPseudoFilters(stats: PseudoStat[], bounds: ModFilterMap): StatFilter[] {
    const ratio = this.settings.trade2.pseudoMinRatio;

    return stats
      .map((stat) => {
        const override = bounds.get(stat.id);
        const min = override ? override.min : Math.floor(pseudoTotal(stat) * ratio);
        const max = override ? override.max : null;

        const value: { min?: number; max?: number } = {};
        if (min !== null && min > 0) value.min = min;
        if (max !== null) value.max = max;
        return Object.keys(value).length > 0 ? { id: stat.id, value } : { id: stat.id };
      })
      // A floor that rounded to nothing is not a constraint; the bare id it becomes still asks for an
      // item carrying the stat at all, which is a real thing to want and what a cleared box means.
      .filter((filter) => filter.value !== undefined || bounds.has(filter.id));
  }

  /** The item's mods as trade2 stat filters, summed per stat id. */
  private async buildStatFilters(
    item: ParsedItem,
    ignoredMods: Set<string>,
    defenceFiltersActive: boolean,
    modFilters: ModFilterMap,
    foldedIntoPseudo: Set<string>
  ): Promise<{
    filters: StatFilter[];
    modsByStat: Map<string, string[]>;
    tiersByStat: Map<string, Array<number | null | undefined>>;
  }> {
    const defences = defencesOf(item);
    // Keyed by display text, which is how `matchMods` hands its results back. Two byte-identical mod
    // lines already collapse into one entry there, so this inherits exactly that blind spot and no
    // other — the same one `ignoredMods` and the user-set bounds have.
    const tierByMod = new Map(modsOf(item).map((mod) => [mod.text, mod.tier]));
    const { matched } = await this.statsMatcher.matchMods(
      modsOf(item)
        .filter((mod) => !ignoredMods.has(mod.text))
        // Folded into a pseudo aggregate above, so searching it individually as well would pin the
        // exact roll the aggregate exists to get away from — the same mistake `isLocalDefenceMod`
        // avoids for armour, and it would undo the widening entirely.
        .filter((mod) => !foldedIntoPseudo.has(mod.text))
        // A mod already inside a defence total must not *also* be a stat filter, or the exact roll
        // it contributed is pinned all over again and the equipment filter buys nothing. Dropping
        // it is the entire point: it's what shortens the ladder and lets the remaining mods relax.
        .filter((mod) => !defenceFiltersActive || !isLocalDefenceMod(mod.text, defences))
    );
    // Summed per stat id, not one filter per mod line. An item can carry the same stat on several
    // affixes — the body armour that surfaced this had two prefixes granting Evasion Rating (+144
    // and +49) and two granting increased Evasion/ES (42% and 108%) — and GGG indexes the *total*,
    // so emitting two filters for one id asks for an item that has 144 and separately 49 rather
    // than the 193 the item actually has. That matches nothing.
    //
    // Iterated by entry rather than by value because the key is the mod's display text, which is
    // what a user-set bound is keyed by too. (Two byte-identical mod lines already collapse into one
    // entry here, so a bound inherits exactly the blind spot `ignoredMods` has.)
    const summed = new Map<string, { min: number | null; max: number | null; maxComplete: boolean }>();
    // Which mod lines produced each stat id, kept so the coverage counted off the returned listings
    // can be reported against the rows the user actually sees. It is one-to-many in both directions'
    // worth of care: two affixes summing into one id must both be credited when a listing carries it.
    const modsByStat = new Map<string, string[]>();
    // The affix tiers behind each stat id, for `droppableFilters()`. Parallel to `modsByStat` rather
    // than folded into it because that map is also what `countCoverage` credits listings against, and
    // widening its value shape would drag the tier through code with no use for it.
    const tiersByStat = new Map<string, Array<number | null | undefined>>();
    for (const [text, { statId, value }] of matched) {
      modsByStat.set(statId, [...(modsByStat.get(statId) ?? []), text]);
      tiersByStat.set(statId, [...(tiersByStat.get(statId) ?? []), tierByMod.get(text)]);
      // A null value means the *template* carries no `#` at all, so this stat is only ever matched on
      // presence and no number belongs on it — whatever a bound says. The editor already renders no
      // boxes for a line with no number in it; this covers the same entry arriving from an older
      // `loot-cache.json`, where the mod text or GGG's reference has since changed under it.
      const override = value === null ? undefined : modFilters.get(text);
      const min = override ? override.min : value;
      const max = override ? override.max : null;

      const running = summed.get(statId) ?? { min: null, max: null, maxComplete: true };
      if (min !== null) running.min = (running.min ?? 0) + min;
      // A ceiling summed from only *some* of the affixes feeding a stat lands below the total the
      // item itself has, which excludes the item from its own comparables. So a max survives only
      // when every mod contributing to this id supplied one.
      if (max === null) running.maxComplete = false;
      else running.max = (running.max ?? 0) + max;
      summed.set(statId, running);
    }
    // A stat with no surviving bound is asked for by presence alone — a bare `{ id }`. Sending
    // `{"min": null}` instead, which is also what a NaN serialises to, matches nothing and takes the
    // entire search to zero results with it.
    const filters = [...summed].map(([id, bounds]) => {
      const value: { min?: number; max?: number } = {};
      if (bounds.min !== null) value.min = bounds.min;
      if (bounds.maxComplete && bounds.max !== null) value.max = bounds.max;
      return Object.keys(value).length > 0 ? { id, value } : { id };
    });
    return { filters, modsByStat, tiersByStat };
  }

  /**
   * How many of the sampled listings carried each of the item's mods.
   *
   * The ladder asks for "at least N of these M", so a rung that matched does **not** mean the same N
   * everywhere — one listing may carry mods 1/2/4 and the next 2/5/6. There is no "the mods that were
   * used"; there is only how often each one turned up, which is what this counts.
   *
   * Free: `extended.hashes` rides along on the fetch that was happening anyway. Groups are flattened
   * rather than read per kind, because a listing can carry the same stat as a crafted or fractured
   * mod where this item has it as an explicit one — matching only the same group would undercount.
   */
  private countCoverage(
    listings: TradeListing[],
    modsByStat: Map<string, string[]>
  ): Array<{ text: string; listings: number }> {
    const counts = new Map<string, number>();
    for (const mods of modsByStat.values()) {
      for (const text of mods) counts.set(text, 0);
    }

    for (const entry of listings) {
      const present = new Set<string>();
      for (const group of Object.values(entry.item?.extended?.hashes ?? {})) {
        for (const [statId] of group) present.add(statId);
      }
      for (const [statId, mods] of modsByStat) {
        if (!present.has(statId)) continue;
        for (const text of mods) counts.set(text, (counts.get(text) ?? 0) + 1);
      }
    }

    return [...counts].map(([text, listings]) => ({ text, listings }));
  }

  /** One search at a single mod threshold. No fetch — only the winning rung is worth spending on. */
  private async searchRung(
    item: ParsedItem,
    statFilters: StatFilter[],
    required: number,
    defenceFilters: DefenceFilter[],
    pseudoFilters: StatFilter[],
    mapFilters: DefenceFilter[]
  ): Promise<RungResult | { failure: { estimate: TradeEstimate; transient: boolean } }> {
    // Both filter groups live under one `query.filters` key, so they have to be assembled together
    // rather than each conditionally spreading its own — the second would replace the first.
    const queryFilters: Record<string, unknown> = {};
    if (item.corrupted) {
      queryFilters.misc_filters = { filters: { corrupted: { option: "true" } } };
    }
    if (defenceFilters.length > 0) {
      queryFilters.equipment_filters = {
        filters: Object.fromEntries(defenceFilters.map(({ id, min }) => [id, { min }]))
      };
    }
    // GGG titles this group "Endgame Filters". Same shape as the equipment one, and it sits under the
    // same `query.filters` key, which is why all three are assembled into one object here.
    if (mapFilters.length > 0) {
      queryFilters.map_filters = {
        filters: Object.fromEntries(mapFilters.map(({ id, min }) => [id, { min }]))
      };
    }
    // Only the opt-out is ever sent. Omitting `sale_type` *is* buyout-or-fixed-price — GGG's filter
    // reference gives that option a `null` id, meaning the state the dropdown is in when nothing is
    // sent, and sending `{ option: null }` explicitly is a 400. Measured on a live search: omitted
    // 239 listings, `unpriced` 93, `any` 332. See `trade2.saleType`.
    if (this.settings.trade2.saleType === "any") {
      queryFilters.trade_filters = { filters: { sale_type: { option: "any" } } };
    }

    // Two sibling groups, and the `count` one stays at index 0. The aggregates are `and` rather than
    // more candidates in the count group because they are the item's headline numbers — an 83% total
    // resistance ring is not comparable to one without it, whatever else matched — and because a
    // count group that included them would shift every ladder threshold and every reported mod
    // count. Confirmed against the live API: a count group and an and group side by side answer 200.
    const statGroups: unknown[] = [];
    if (statFilters.length > 0) {
      // `count` with a minimum, never `and`. See requiredModMatches() for why.
      statGroups.push({ type: "count", value: { min: required }, filters: statFilters });
    }
    if (pseudoFilters.length > 0) {
      statGroups.push({ type: "and", filters: pseudoFilters });
    }

    const searchResponse = await this.gggFetch(
      `${API_BASE}/search/${REALM}/${encodeURIComponent(this.settings.league)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            // Online-only by default: an offline seller's asking price is not a price anyone can
            // pay today. See `trade2.listingStatus` for why this is a setting and not a constant.
            status: { option: this.settings.trade2.listingStatus },
            type: item.baseType,
            // Constrained only for a corrupted item, which really does trade as its own market —
            // an uncorrupted one can still be modified and is worth more, so pricing a corrupted
            // drop off uncorrupted listings overstates it. The reverse is a soft distinction and
            // demanding it costs matches these thin bases cannot spare: on a real Runeforged
            // Falconer's Jacket, `corrupted: false` alone took the result count from 1 to 0.
            //
            // Omitted entirely when neither group applies, so an item this doesn't touch sends
            // exactly the payload it always did.
            ...(Object.keys(queryFilters).length > 0 ? { filters: queryFilters } : {}),
            // Built above. Guarded on the assembled array rather than on `statFilters` alone: an item
            // whose every mod folded into an aggregate has no count group and would otherwise have
            // dropped its pseudo group along with it.
            ...(statGroups.length > 0 ? { stats: statGroups } : {})
          },
          // Ascending price, so the ids come back in a known order and `priceSample` can take the
          // cheapest of them rather than an arbitrary slice. GGG normalises across currencies for
          // this sort, so a chaos-priced listing is ordered against exalted-priced ones rather than
          // grouped separately.
          sort: { price: "asc" }
        })
      }
    );

    if (!searchResponse.ok) {
      return { failure: await this.describeHttpFailure(searchResponse, "search") };
    }

    const searchBody = (await searchResponse.json()) as {
      id: string;
      result: string[];
      total?: number;
    };
    const rung = {
      required,
      searchId: searchBody.id,
      ids: searchBody.result,
      total: searchBody.total ?? searchBody.result.length
    };
    const defenceNote = defenceFilters.length > 0 ? ` and ${describeDefences(defenceFilters)}` : "";
    const mapNote = mapFilters.length > 0 ? ` and ${describeMapFilters(mapFilters)}` : "";
    const pseudoNote =
      pseudoFilters.length > 0
        ? ` and ${pseudoFilters.map((filter) => `${filter.value?.min ?? "any"}+ ${filter.id.replace("pseudo.pseudo_", "")}`).join(", ")}`
        : "";
    console.log(
      `[trade2] "${item.baseType}" with ${required} of ${statFilters.length} mod filter(s)` +
        `${defenceNote}${pseudoNote}${mapNote}: ${rung.total} listing(s)`
    );
    return rung;
  }

  /** Fetches the winning rung's sampled listings and reduces them to one chaos value. */
  private async priceFromRung(
    rung: RungResult,
    totalMods: number,
    rungs: Array<{ required: number; total: number; filters: number }>,
    defences: DefenceFilter[],
    defencesDropped: boolean,
    toChaos: (amount: number, currency: string) => number | null,
    pseudoStats: PseudoStat[],
    pseudoDropped: boolean,
    mapDropped: boolean,
    modsByStat: Map<string, string[]>,
    autoDroppedMods: string[]
  ): Promise<{ estimate: TradeEstimate; transient: boolean }> {
    const ids = priceSample(rung.ids, Math.min(this.settings.trade2.maxListings, MAX_FETCH_IDS));

    const fetchResponse = await this.gggFetch(
      `${API_BASE}/fetch/${ids.join(",")}?query=${encodeURIComponent(rung.searchId)}&realm=${REALM}`
    );
    if (!fetchResponse.ok) {
      return this.describeHttpFailure(fetchResponse, "fetch");
    }

    const fetchBody = (await fetchResponse.json()) as { result: TradeListing[] };
    const chaosValues = fetchBody.result
      .map((entry) => entry.listing.price)
      .filter((price): price is { amount: number; currency: string } => price !== null)
      .map((price) => toChaos(price.amount, price.currency))
      .filter((value): value is number => value !== null);

    if (chaosValues.length === 0) {
      return definitive(
        `${fetchBody.result.length} listing(s) found but none had a price this app could convert ` +
          "to chaos (unpriced stash tabs, or a currency poe.ninja isn't tracking)"
      );
    }

    // Both ends of the cheap window `priceSample` selected, because they answer different questions.
    // The reported price is the **floor** — the cheapest listing, i.e. what you can undercut into
    // today. The median of the same window rides along as the check on how thin that floor is: a
    // floor far below it is one optimistic seller, and the two figures side by side say so, which a
    // single number never could. The median still earns its keep as the *second* number for the
    // reason it earned it as the first — one mispriced or unconverted-currency outlier among five
    // would drag a mean, and the cheap end is exactly where those live.
    //
    // Re-sorted rather than trusting GGG's order, because the ids came back sorted by GGG's own
    // cross-currency normalisation while these are this app's chaos conversions, which can disagree.
    chaosValues.sort((a, b) => a - b);
    return {
      estimate: {
        chaosValue: chaosValues[0],
        medianChaosValue: chaosValues[Math.floor(chaosValues.length / 2)],
        reason: null,
        listings: chaosValues.length,
        matches: rung.total,
        searchId: rung.searchId,
        matchedMods: rung.required,
        totalMods,
        rungs,
        defences,
        defencesDropped,
        pseudoStats,
        pseudoDropped,
        mapDropped,
        // Counted over the fetched listings, not the ones with a convertible price: a listing whose
        // currency this app can't convert still tells you which mods the market carries.
        statCoverage: this.countCoverage(fetchBody.result, modsByStat),
        coverageSample: fetchBody.result.length,
        autoDroppedMods
      },
      transient: false
    };
  }

  private async describeHttpFailure(
    response: Response,
    stage: string
  ): Promise<{ estimate: TradeEstimate; transient: boolean }> {
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      // Deliberately not transient. A 429 means TradeSearchBudget is set too high for this IP, and
      // GGG's Retry-After here runs to minutes - waiting it out would stall every queued item.
      return definitive(
        `trade2 rate-limited this IP (HTTP 429${retryAfter ? `, retry after ${retryAfter}s` : ""}) - ` +
          "lower trade2.maxSearchesPerWindow in settings if this keeps happening"
      );
    }
    const body = (await response.json().catch(() => null)) as GggErrorBody | null;
    const detail = body?.error ? `: ${body.error.message} (code ${body.error.code})` : "";
    const reason = `trade2 ${stage} returned HTTP ${response.status}${detail}`;
    // 5xx is GGG being briefly unwell; 4xx means the query itself was rejected and will be again.
    return { estimate: noPrice(reason), transient: response.status >= 500 };
  }
}
