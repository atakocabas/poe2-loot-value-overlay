// Trade2 search. **Read docs/pricing-trade2.md before changing how an item is searched for.**
// Nearly every rule in this file is a measured result against live GGG data, and several look like
// bugs until you read why they aren't: the removed count axis, the price floor carrying no
// `option`, the strict rung never being walked past, the drop ladder's ordering, the pseudo
// aggregates. Four repeat regressions came from changing these without reading it.
import type { Settings } from "../shared/settings";
import type {
  ItemDefences,
  ModFilter,
  ParsedItem,
  PseudoStat,
  TradeFailure
} from "../shared/types";
import type { ListingQuote } from "../shared/format-value";
import { createPublicGggFetch, type GggFetch } from "./ggg-fetch";
import { modsOf } from "../shared/mods";
import { defencesOf, isLocalDefenceMod } from "../shared/defences";
import { elementalDpsOf, isLocalElementalDamageMod, weaponStatsOf } from "../shared/weapon-stats";
import { searchFloor } from "../shared/mod-rolls";
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
    /**
     * ISO-8601, when GGG indexed the listing — how old the asking price is.
     *
     * Optional because the app has never verified it against a live response, and because a listing
     * with no usable date has to behave exactly like an item stored before this was read: the row
     * says nothing rather than guessing. See `TradeEstimate.listingIndexedAt`.
     */
    indexed?: string;
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
  /**
   * Sent, shown on the trade site, and **ignored by the search** — which is how a rung can carry the
   * mods it dropped without them constraining anything. Confirmed live against trade2: a Sapphire
   * Ring search matching 10000 on life alone still matched 10000 with a cold-resistance filter added
   * as disabled, and 2465 with the same filter enabled. Verified for both group types.
   *
   * Omitted entirely rather than sent as false, matching how `value` and its bounds are handled.
   */
  disabled?: boolean;
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
/**
 * GGG's `equipment_filters` id for elemental DPS. Named because it travels in the same list as the
 * defences, and the two mod folds each have to ask whether their own floor is being sent.
 */
const EDPS_FILTER_ID = "edps";

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

/**
 * One `map_filters` entry. Deliberately not a `DefenceFilter`, which the defence and weapon filters
 * share and which is always a floor: a waystone's difficulty is searched as a ceiling, so this needs
 * both bounds optional. Keeping them separate means the `defencesDropped` retry and `describeDefences`
 * go on meaning exactly what they did.
 */
interface MapFilter {
  id: string;
  min?: number;
  max?: number;
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
   * Read `listingIndexedAt` beside it: a floor from a listing posted three days ago is a different
   * fact from the same number posted an hour ago, and the number alone cannot say which.
   */
  chaosValue: number | null;
  /**
   * When the cheapest listing was posted, as epoch ms — the age of the quote behind `chaosValue`.
   *
   * Parsed here rather than carried as GGG's ISO string, so one representation reaches the row and
   * `relativeTime` can take it directly. Absent whenever there is no price, and whenever the listing
   * carried no date this could parse — the row draws nothing in both cases rather than guessing.
   */
  listingIndexedAt?: number;
  /**
   * What the cheapest listing was asking, in its own currency — the quote behind `chaosValue`.
   *
   * Display only, and only to pick the unit a row is shown in. See `PricedItem.tradeListingQuote`.
   * Absent whenever there is no price to have come from a listing.
   */
  listingQuote?: ListingQuote;
  /**
   * Every convertible listing the price was reduced from, cheapest first — the chaos value of each
   * and when it went up.
   *
   * `chaosValue` is `listingSample[0].chaos`. The rest used to be dropped on the floor here, which
   * is what made a price off one listing indistinguishable from a price off ten once the median was
   * removed. Carried so the row editor can weigh the cheap end by how long each of it has gone
   * unsold; see `suggestSellRange` in the renderer, which is the only reader.
   *
   * This is the cheapest handful of a price-ascending search — the market's left tail, not a sample
   * of it. Absent whenever there is no price for it to be the basis of.
   */
  listingSample?: Array<{ chaos: number; indexedAt?: number }>;
  /** Why there is no value. null when `chaosValue` is set. */
  reason: string | null;
  /**
   * *Which kind* of failure is why there is no value. null when `chaosValue` is set.
   *
   * Carried as a typed kind rather than left for the caller to pattern-match out of `reason`, because
   * that string is user-facing prose that gets reworded — several call sites produce the same kind
   * sharing no wording. It is what separates "nothing on the market matches this item" from "nobody
   * looked yet" — the first is a fact about the item and the second expires on its own, and the row
   * has to be able to say which. See `TradeFailure` for the full set and what each one asks of the
   * user; `PricedItem.unpricedReason` is where it lands.
   */
  failure: TradeFailure | null;
  /** How many listings the price was taken over — the sample, not the whole match set. */
  listings: number;
  /** How many online listings the search matched in total, which the sample is drawn from. */
  matches: number;
  /**
   * GGG's id for the search this price came from — the rung that was actually fetched, not the
   * stricter ones the ladder passed over, so opening it shows the listings the price was taken
   * from rather than a query that returned nothing.
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
   * the drop axis: a rung requires *all* of a named subset, so what it left out is known exactly.
   * That is what lets the row editor reopen with the surviving mods ticked.
   *
   * Empty whenever the top rung matched, which is every price that rests on the item's whole mod set.
   */
  autoDroppedMods: string[];
  /**
   * Every mod line that constrained the winning query, by whichever route it reached it: its own
   * stat filter on the rung that was fetched, a pseudo aggregate that was applied, or an equipment
   * defence floor that was applied.
   *
   * The third real set alongside `autoDroppedMods` and `statCoverage`, and the three answer three
   * different questions. `autoDroppedMods` names what the drop axis removed. `statCoverage`
   * *measures* what the returned listings carried, which is only informative about the mods the query
   * did **not** demand — every listing carries all of the ones it did. This names what the query
   * asked for, which is known exactly whichever rung won, because the request was built from it.
   *
   * A mod absent from all three reached no filter group at all — almost always because GGG's stat
   * reference has no template matching its text, so it could not be searched even in principle.
   * That is the distinction the row editor's ticks carry.
   */
  searchedMods: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noPrice(reason: string, failure: TradeFailure): TradeEstimate {
  return {
    chaosValue: null,
    reason,
    failure,
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
    autoDroppedMods: [],
    searchedMods: []
  };
}

/**
 * "21+ Item Rarity, 76+ Waystone Drop Chance, <=15 Monster Effectiveness" — how a waystone's
 * constraints are named in the log and the no-match message.
 *
 * The direction has to survive into the text. This string is what tells a user which way to tune when
 * nothing matched, and a ceiling reported as a floor sends them the wrong way.
 */
export function describeMapFilters(filters: MapFilter[]): string {
  return filters
    .map((filter) => {
      const label = mapFilterLabel(filter.id);
      if (filter.min !== undefined && filter.max !== undefined) {
        return `${filter.min}-${filter.max} ${label}`;
      }
      return filter.max !== undefined ? `<=${filter.max} ${label}` : `${filter.min}+ ${label}`;
    })
    .join(", ");
}

/** "973+ Armour, 216+ Evasion" — how a defence constraint is named in a message. */
export function describeDefences(defences: DefenceFilter[]): string {
  const labels: Record<string, string> = {
    ar: "Armour",
    ev: "Evasion",
    es: "Energy Shield",
    ward: "Ward",
    // Not a defence, but it travels in the same `equipment_filters` list for the reasons in
    // `buildDefenceFilters` — so it needs a name here or the message reads "214+ edps".
    edps: "Elemental DPS"
  };
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
function definitive(
  reason: string,
  failure: TradeFailure
): { estimate: TradeEstimate; transient: boolean } {
  return { estimate: noPrice(reason, failure), transient: false };
}

/**
 * The fewest stat filters a rung may still send — the floor the drop axis is not allowed to cross.
 *
 * Dropping is the only relaxation there is now, so something has to stop it shedding a five-mod rare
 * down to one filter: that query is a base-type search wearing a single mod, and the price it returns
 * is for an item this isn't. At the shipped ratio of 0.5 a five-mod rare never searches on fewer
 * than three of its mods.
 *
 * The floor of 2 and the cap at `count` both earn their place at the small end — a one- or two-mod
 * item is already specific enough to match and has nothing to spare, so both yield zero drops.
 *
 * This is the old `requiredModMatches` arithmetic, unchanged and repointed. It used to answer "how
 * many of these mods must a listing share" for the `count` group; it now answers "how many must stay
 * in the query", which is the same number making a **stricter** promise — every survivor is required,
 * where before any N of them would do.
 */
export function minSurvivingFilters(count: number, ratio: number): number {
  if (count === 0) return 0;
  return Math.min(count, Math.max(2, Math.ceil(count * ratio)));
}

/**
 * Every stat filter in the order the ladder should shed them, **most expendable first**.
 *
 * A *total* ordering, not a shortlist. Dropping is the only relaxation left — the `count` axis is
 * gone, because "any 4 of these 5" lets a listing miss the T1 roll that is the entire reason the item
 * is worth anything, and *which* 4 differs per listing, so no set of mods can be reported back.
 * Dropping a named filter and requiring all the survivors asks for a specific, weaker item, which is
 * both how a player narrows a search by hand and the only relaxation whose result is knowable.
 *
 * That is why this can no longer return `[]` for an item it knows nothing about, which is what it did
 * before: with no count tail behind it, such an item would be left with a single all-mods rung, and
 * an all-mods rung measured **zero** listings for an ordinary five-mod rare.
 *
 * Three bands, and the order between them is the design:
 *
 * 1. **Known weak** — tier known and at or past `tierThreshold`. Worst tier first.
 * 2. **Unknown** — no tier printed, because the player isn't running Advanced Item Descriptions or
 *    the header carried no `(Tier: N)`. Item order.
 * 3. **Known good** — tier known and better than the threshold. Worst first, so T2 goes before T1.
 *
 * Shed what is known to be weak, then what nothing is known about, then what is known to be good.
 * `tierThreshold` still decides what "weak" means but no longer **forbids** anything: it is a
 * priority boundary now, not a gate, and an item with no tier data degrades to item order rather
 * than to no relaxation at all.
 *
 * Two rules survive unchanged, both conservative in the same direction:
 *
 * - **A filter is ranked by its *best* contributor, not its worst.** Filters are summed per stat id
 *   (see `buildStatFilters`), so one can be fed by several mod lines, and dropping it drops all of
 *   them. Ranking by the worst would let a T5 roll carry a T1 off the search with it.
 * - **Ties keep the item's own order**, so the same item always produces the same ladder and a
 *   reported mod set is reproducible.
 */
export function droppableFilters(
  order: Array<{ statId: string; tiers: Array<number | null | undefined> }>,
  tierThreshold: number
): string[] {
  const ranked = order.map((filter, index) => {
    const known = filter.tiers.filter((tier): tier is number => typeof tier === "number");
    // A filter is only "known" when *every* contributor printed a tier. One unknown line means the
    // filter as a whole is a guess, and no contributors at all is the same case — never a vacuously
    // droppable one, which is what `Math.min()` of nothing (Infinity) would have made it.
    const best = known.length > 0 && known.length === filter.tiers.length ? Math.min(...known) : null;
    const band = best === null ? 1 : best >= tierThreshold ? 0 : 2;
    return { statId: filter.statId, band, best, index };
  });

  // Band first, then worst tier within a band, then the item's own order.
  ranked.sort((a, b) => a.band - b.band || (b.best ?? 0) - (a.best ?? 0) || a.index - b.index);
  return ranked.map((entry) => entry.statId);
}

/**
 * The full sequence of searches one lookup may send, strictest first.
 *
 * One axis now, not two:
 *
 * 1. every filter, all required — "price *this* item", and the first thing worth asking;
 * 2. one rung per dropped filter, still requiring **all** the survivors, most expendable first.
 *
 * **Every rung requires all of its own filters**, which is the property the whole thing rests on: the
 * surviving set is known exactly, so the price can be reported back as the mods it came from
 * (`autoDroppedMods` and `searchedMods`). The `count` tail that used to sit at the end could not say
 * that — different listings satisfy different subsets of "any 4 of 5" — and it is gone deliberately.
 * Don't reintroduce it to widen coverage; it prices a different item and nothing can say which.
 *
 * The set is never shed past `minSurvivingFilters()`, so a rung is never so loose that it is a
 * base-type search wearing one mod.
 */
/**
 * A rung's own filters, followed by everything the ladder shed from it — marked disabled.
 *
 * GGG sends a disabled filter back to the trade site as a present-but-unchecked row and **ignores it
 * when matching**, which is what lets the "View search" link open the whole mod table with the query's
 * own mods ticked and the dropped ones visibly not. Verified live against trade2: a Sapphire Ring
 * search matching 10000 on life alone still matched 10000 with a cold-resistance filter added as
 * disabled, and 2465 with that same filter enabled.
 *
 * Identity comparison is sound because every rung's filter list is a `.filter()` of this same array.
 */
function withDisabled(all: StatFilter[], enabled: StatFilter[]): StatFilter[] {
  return [
    ...enabled,
    ...all
      .filter((filter) => !enabled.includes(filter))
      .map((filter) => ({ ...filter, disabled: true }))
  ];
}

/** A whole group the search dropped: present on the trade site, constraining nothing. */
function allDisabled(filters: StatFilter[]): StatFilter[] {
  return filters.map((filter) => ({ ...filter, disabled: true }));
}

export function searchRungs<F extends { id: string }>(
  filters: F[],
  dropOrder: string[],
  options: { ratio: number; maxDropSteps: number }
): Array<{ filters: F[]; required: number; dropped: string[] }> {
  const rungs: Array<{ filters: F[]; required: number; dropped: string[] }> = [
    { filters, required: filters.length, dropped: [] }
  ];

  const maxDrops = Math.min(
    dropOrder.length,
    Math.floor(options.maxDropSteps),
    // Subsumes the old "never empty the set" guard: the floor is at least 2 for anything bigger.
    filters.length - minSurvivingFilters(filters.length, options.ratio)
  );

  for (let drops = 1; drops <= maxDrops; drops++) {
    const removed = dropOrder.slice(0, drops);
    const subset = filters.filter((filter) => !removed.includes(filter.id));
    rungs.push({ filters: subset, required: subset.length, dropped: removed });
  }

  return rungs;
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

    // The knobs that decide how the ladder walks, printed once at construction rather than per
    // lookup. Two adjacent rung lines in the log are ambiguous on their own — is this ladder even
    // allowed to stop where I think? — and answering that by reading settings.json is answering it
    // from the wrong place, since what matters is the value this process actually loaded.
    const { minListingsForMatch, minModMatchRatio, maxModDropSearches, modDropTierThreshold } =
      settings.trade2;
    console.log(
      `[trade2] ladder: stop at >= ${minListingsForMatch} listing(s), shed at most ` +
        `${maxModDropSearches} mod(s), keep >= ${minModMatchRatio} of them, weak means tier >= ` +
        `${modDropTierThreshold}`
    );
  }

  /** Whether lookups are switched on at all. The only remaining kill switch — there is no login. */
  get isAvailable(): boolean {
    return this.settings.trade2.enabled;
  }

  /**
   * How long until a search could go out, in ms; 0 when one could go now.
   *
   * Delegated rather than exposing `budget`, for the reason this file already states about the
   * enabled and item-level gates: one place decides whether a lookup happens. The panel counts down
   * against this so a rate-limited row can say *when* pressing Reprice is worth it — the "retry in
   * ~Ns" inside `TradeEstimate.reason` is frozen at the moment the refusal was worded and goes stale
   * within seconds.
   *
   * 0 covers both "budget free" and "nothing ever reserved". They are the same thing to a caller.
   */
  cooldownMs(): number {
    return this.budget.cooldownMs();
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
      return noPrice(
        "trade2 lookups are switched off (trade2.enabled is false in settings)",
        "notSearched"
      );
    }
    if (!item.baseType) {
      return noPrice(
        "no base type to search on — trade2 searches by base type plus mod filters",
        "notSearched"
      );
    }
    // A white base is priced on its item level and nothing else, so it is only worth a request once
    // that level is high enough to be worth crafting on. The refusal lives here rather than in the
    // resolver for the same reason the budget and enabled checks do: one place decides whether a
    // lookup happens, and one place words why it didn't.
    if (item.rarity === "Normal") {
      const { useBaseItemSearch, baseItemMinLevel } = this.settings.trade2;
      if (!useBaseItemSearch) {
        return noPrice(
          "base items aren't searched (trade2.useBaseItemSearch is false in settings) — set a " +
            "manual price with the row's Edit button",
          "notSearched"
        );
      }
      if (item.itemLevel === null) {
        return noPrice(
          "this base printed no item level, which is the only thing a white item is priced on — " +
            "set a manual price with the row's Edit button",
          "notSearched"
        );
      }
      if (item.itemLevel < baseItemMinLevel) {
        return noPrice(
          `item level ${item.itemLevel} is below trade2.baseItemMinLevel (${baseItemMinLevel}), so ` +
            "no search was made — lower that setting, or set a manual price with the row's Edit button",
          "notSearched"
        );
      }
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
        // A spent budget mid-retry shouldn't hide what actually went wrong first. Still flagged as
        // rate-limited: the transient error is why the first attempt failed, but the budget is why
        // there was no second one, and waiting for the window is what the user has to do either way.
        if (lastTransient) return noPrice(`${lastTransient}; no budget left to retry`, "rateLimited");
        return noPrice(
          `trade2 search budget spent (${this.settings.trade2.maxSearchesPerWindow} per ` +
            `${Math.round(this.settings.trade2.windowMs / 60000)}min; GGG rate-limits by IP) - ` +
            `retry in ~${seconds}s with the row's Reprice button`,
          "rateLimited"
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
        "retry later with the row's Reprice button",
      "searchFailed"
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
      return {
        estimate: noPrice(`trade2 request failed: ${message}`, "searchFailed"),
        transient: true
      };
    }
  }

  /**
   * Walks `searchRungs()` from "every mod" downwards, shedding one mod per rung, and prices off the
   * strictest rung that describes an actual market — then fetches **once** for whichever rung won.
   *
   * "Strictest that matched anything" is the wrong stopping rule, and the item that prompted this
   * shows why: a real four-mod Ruby jewel had exactly **one** online listing carrying all four mods,
   * at 30 chaos, while eleven listings shared three of them and ran 1-500 exalted. A price taken from
   * one listing is that listing, so the exact-match rung would have reported one stranger's asking price
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
          tiersByStat: new Map<string, Array<number | null | undefined>>(),
          defenceFolded: [] as string[]
        }
      : await this.buildStatFilters(
          item,
          ignoredMods,
          {
            // Asked separately, because the two features share a filter list but not a switch: with
            // `useDefenceFilters` off and `useWeaponFilters` on, folding an armour roll away would
            // leave it constraining nothing at all.
            defences: defenceFilters.some((filter) => filter.id !== EDPS_FILTER_ID),
            weapon: defenceFilters.some((filter) => filter.id === EDPS_FILTER_ID)
          },
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
    // one more thing a listing may or may not share, so it must not shift what the ladder sheds —
    // nor the counts reported from it.
    const ladder = searchRungs(statFilters, dropOrder, {
      ratio: trade2.minModMatchRatio,
      maxDropSteps: trade2.maxModDropSearches
    });

    // What the search is actually asking for, mod by mod, before any of it is shed. Printed once per
    // lookup rather than per rung because the floors don't change as the ladder descends — only which
    // of them are still enabled — and it is the line that makes a result reproducible by hand on the
    // trade site, which is how every "it hits there but not here" report has been settled.
    if (statFilters.length > 0) {
      const asked = statFilters.map((filter) => {
        const mods = built.modsByStat.get(filter.id) ?? [];
        const label = mods.join(" + ") || filter.id;
        return filter.value?.min === undefined ? `${label} (any roll)` : `${label} >= ${filter.value.min}`;
      });
      console.log(`[trade2] "${item.name}" asking for ${asked.join("; ")}`);
    }

    let best: RungResult | null = null;
    let bestDropped: string[] = [];
    // The filters the winning rung actually sent, kept for the same reason `bestDropped` is. The
    // ladder's rungs are subsets of one another, so which one won is what decides the set the price
    // was asked for; discarding it was why nothing downstream could say which mods produced a price.
    let bestFilters: StatFilter[] = [];
    const rungs: Array<{ required: number; total: number; filters: number }> = [];
    let budgetStopped = false;

    // Always at least the all-filters rung, including the empty one: an item whose only matchable
    // mods were defence mods leaves no stat filters, but "this base with at least this much armour"
    // is a real query and worth sending rather than falling through to "no listings for base type",
    // which would be a flat lie about a search that was never run.
    const rungsToTry = ladder;

    for (const [step, candidate] of rungsToTry.entries()) {
      if (step > 0 && !(await this.spendBudgetSlot())) {
        budgetStopped = true;
        break;
      }

      const rung = await this.searchRung(
        item,
        withDisabled(statFilters, candidate.filters),
        candidate.required,
        defenceFilters,
        pseudoFilters,
        mapFilters,
        `rung ${step + 1}/${rungsToTry.length}`
      );
      if ("failure" in rung) return rung.failure;
      rungs.push({ required: candidate.required, total: rung.total, filters: candidate.filters.length });

      if (rung.total > 0) {
        best = rung;
        bestDropped = candidate.dropped;
        bestFilters = candidate.filters;
      }

      const enough = rung.total >= trade2.minListingsForMatch;
      // **The rung that dropped nothing is the item itself, not a relaxation of it**, so the
      // threshold does not apply to it. `minListingsForMatch` exists to stop a rung that *shed* mods
      // being taken on too little evidence — a real Ruby jewel had 1 listing at four mods and 263 at
      // two, and the two-mod figure was the honest market. That argument does not reach the first
      // rung: when listings carry the item's whole mod set, those listings **are** its comparables,
      // and walking past them prices a different item. A real four-mod Sapphire had 9 listings at all
      // four mods and was priced at 0.12 chaos off 147 sharing three, where the four-mod market
      // started at 4 divine. How thin the sample is, the row no longer says — the median that used
      // to carry that signal was removed, so `listings` in the log is the only place it survives.
      const exactHit = candidate.dropped.length === 0 && rung.total > 0;

      // Why the ladder stopped where it did, in the same line as the count it decided on. Two
      // adjacent rung lines used to leave this to be inferred — a rung with listings that carried on
      // anyway reads as a bug unless the threshold it fell short of is printed next to it, and
      // `minListingsForMatch` is loaded once at boot, so reading settings.json afterwards can
      // disagree with the value this process is actually using.
      const last = step === rungsToTry.length - 1;
      console.log(
        `[trade2] "${item.name}" rung ${step + 1}/${rungsToTry.length} -> ` +
          (exactHit && !enough
            ? `${rung.total} listing(s), under the ${trade2.minListingsForMatch} needed but they carry ` +
              "every mod - pricing from this rung"
            : enough
              ? `${rung.total} listing(s), at or over the ${trade2.minListingsForMatch} needed - pricing from this rung`
              : rung.total > 0
                ? `${rung.total} listing(s), under the ${trade2.minListingsForMatch} needed` +
                  (last ? " and no looser rung left - pricing from it anyway" : " - shedding a mod and retrying")
                : "no listings" + (last ? " and no looser rung left" : " - shedding a mod and retrying"))
      );
      if (enough || exactHit) break;
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
          withDisabled(statFilters, looseRung.filters),
          looseRung.required,
          defenceFilters,
          allDisabled(pseudoFilters),
          mapFilters,
          "retry without aggregates"
        );
        if ("failure" in rung) return rung.failure;
        if (rung.total > 0) {
          best = rung;
          bestDropped = looseRung.dropped;
          bestFilters = looseRung.filters;
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
        const rung = await this.searchRung(
          item,
          withDisabled(statFilters, looseRung.filters),
          looseRung.required,
          [],
          allDisabled(pseudoFilters),
          mapFilters,
          "retry without defences"
        );
        if ("failure" in rung) return rung.failure;
        if (rung.total > 0) {
          best = rung;
          bestDropped = looseRung.dropped;
          bestFilters = looseRung.filters;
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
        const rung = await this.searchRung(
          item,
          withDisabled(statFilters, looseRung.filters),
          looseRung.required,
          defenceFilters,
          allDisabled(pseudoFilters),
          [],
          "retry on base type"
        );
        if ("failure" in rung) return rung.failure;
        if (rung.total > 0) {
          best = rung;
          bestDropped = looseRung.dropped;
          bestFilters = looseRung.filters;
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

    // Each rung as the number of mods it searched on. The two numbers used to differ — a count rung
    // required 4 of 5 while a drop rung required all 4 of 4 — but every rung is an `and` over its own
    // filters now, so one number says it.
    const lastRung = rungs[rungs.length - 1];
    const triedLabel = rungs.map((rung) => String(rung.filters)).join(", ");

    if (!best && budgetStopped) {
      // Distinct from "nothing matches": the looser rungs that would have priced this were never
      // sent, so the row's Reprice really will find something once the window refills.
      return definitive(
        `no ${this.listingsLabel}${this.describePriceFloor()} match this ${item.baseType}` +
          `${withDefences} on ${lastRung?.filters ?? statFilters.length} of its mods, and the ` +
          `search budget ran out before trying fewer - retry in ` +
          `~${Math.ceil(this.budget.cooldownMs() / 1000)}s with the row's Reprice button`,
        "rateLimited"
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
          ? `no ${this.listingsLabel}${this.describePriceFloor()} match this ${item.baseType} on ` +
              `as few as ${lastRung?.filters ?? 0} of its ${statFilters.length} mods at these rolls ` +
              `(tried ${triedLabel} mods) - ` +
              'press Edit on the row, untick the rare mods, then "Reprice via trade"'
          : `no ${this.listingsLabel}${this.describePriceFloor()} for base type ` +
              `"${item.baseType}"${withDefences}`,
        "noListings"
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

    // What the winning query actually asked for, by every route a mod can reach it: its own stat
    // filter on the rung that was fetched, a pseudo aggregate, or a defence floor. The row editor
    // ticks exactly this, so a mod GGG's reference could not match reads as unsearched rather than
    // as one the price rests on.
    //
    // The two `*Dropped` arms are the point of doing this here rather than from `bestFilters` alone:
    // a filter group that was retried away constrained nothing, so the mods folded into it
    // constrained nothing either, and ticking them would credit the price to rolls it never asked for.
    const searchedMods = [
      ...bestFilters.flatMap((filter) => built.modsByStat.get(filter.id) ?? []),
      ...(pseudoDropped ? [] : [...foldedIntoPseudo]),
      ...(defencesDropped ? [] : built.defenceFolded)
    ];

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
      droppedMods,
      searchedMods
    );
  }

  /**
   * The price floor as a phrase, or "" when it is switched off.
   *
   * Shared by the per-rung log and by every no-match message, for the same reason `listingsLabelFor`
   * is shared: the floor is a constraint the user can lift, so a message that reports finding nothing
   * without naming it sends them to loosen mods that were never the problem.
   */
  private describePriceFloor(): string {
    const { minListingPrice } = this.settings.trade2;
    // No currency in the wording, because the filter names none — see the note on `trade_filters`
    // for why saying "1 exalted" was both wrong and the reason listings went missing.
    return minListingPrice > 0 ? ` priced at or above ${minListingPrice}` : "";
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
   * matches are items strictly better than this one, and a price off those describes something the
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
  private buildMapFilters(item: ParsedItem, bounds: ModFilterMap): MapFilter[] {
    if (!this.settings.trade2.useMapFilters) return [];

    const ratio = this.settings.trade2.mapMinRatio;

    return mapRowsOf(item)
      .map((row) => {
        // A bound the user typed in the row editor wins outright, in whichever direction they typed
        // it — the same rule the mod rows follow. Only an untouched row gets the computed default.
        const override = bounds.get(row.id);
        if (override && (override.min !== null || override.max !== null)) {
          return {
            id: row.id,
            ...(override.min !== null && { min: override.min }),
            ...(override.max !== null && { max: override.max })
          };
        }
        // One ratio serves both directions, for the same reason `defenceMinRatio` also serves eDPS: a
        // second knob would only ever hold the same number. It widens away from the item's own value
        // either way — down to a floor, up to a ceiling.
        return row.direction === "max"
          ? { id: row.id, max: Math.ceil(row.value / ratio) }
          : { id: row.id, min: Math.floor(row.value * ratio) };
      })
      .filter((filter) => filter.max !== undefined || (filter.min ?? 0) > 0);
  }

  private buildDefenceFilters(item: ParsedItem): DefenceFilter[] {
    // A white base has no affixes, so its printed numbers are the base's own and the base type
    // already pins them — the same argument that keeps `map_tier` off a waystone whose type is
    // per-tier. Sending them anyway is worse than redundant: the printed value moves with quality,
    // so a floor taken off a 20% one quietly excludes every 0% listing of the identical base.
    if (item.rarity === "Normal") return [];

    const defences = defencesOf(item);
    const ratio = this.settings.trade2.defenceMinRatio;

    // Each half of this list has its own switch, because they are two features that happen to share a
    // filter group: an install can want armour totals and not weapon DPS, or the reverse.
    const filters = !this.settings.trade2.useDefenceFilters
      ? []
      : (Object.keys(DEFENCE_FILTER_IDS) as Array<keyof ItemDefences>)
          .filter((key) => defences[key] !== null && defences[key]! > 0)
          .map((key) => ({ id: DEFENCE_FILTER_IDS[key], min: Math.floor(defences[key]! * ratio) }));

    // Elemental DPS rides in this same list rather than a group of its own, and that is the whole
    // wiring: `searchRung` already writes these into `equipment_filters`, the `defencesDropped` retry
    // already loosens them together, `describeDefences` already names them, and `defenceFolded`
    // already counts the mods they absorbed as searched. A parallel mechanism would have to repeat
    // all four to say the same thing.
    //
    // It is the armour argument applied to a weapon: GGG indexes the DPS the game prints, with every
    // `Adds # to # Fire Damage` roll already inside it, so asking for those rolls individually asks
    // for a weapon nobody else has while asking for the DPS finds the market.
    const elementalDps = this.settings.trade2.useWeaponFilters ? elementalDpsOf(item) : null;
    if (elementalDps !== null && elementalDps > 0) {
      filters.push({ id: EDPS_FILTER_ID, min: Math.floor(elementalDps * ratio) });
    }

    return filters.filter((filter) => filter.min > 0);
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
   * items strictly better than this one, and a price off those describes something the item isn't.
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
    active: { defences: boolean; weapon: boolean },
    modFilters: ModFilterMap,
    foldedIntoPseudo: Set<string>
  ): Promise<{
    filters: StatFilter[];
    modsByStat: Map<string, string[]>;
    tiersByStat: Map<string, Array<number | null | undefined>>;
    /**
     * The mods that left the stat filters because their roll is already inside an equipment defence
     * floor. Reported rather than discarded because they *are* constraining the search, through
     * `equipment_filters` instead of a stat id — so anything asking "which mods did this price come
     * from" has to count them.
     */
    defenceFolded: string[];
  }> {
    const defences = defencesOf(item);
    const weapon = weaponStatsOf(item);
    const defenceFolded: string[] = [];
    // Keyed by display text, which is how `matchMods` hands its results back. Two byte-identical mod
    // lines already collapse into one entry there, so this inherits exactly that blind spot and no
    // other — the same one `ignoredMods` and the user-set bounds have.
    const tierByMod = new Map(modsOf(item).map((mod) => [mod.text, mod.tier]));
    // Same keying, for the same reason: `matchMods` hands its results back by display text.
    const rangeByMod = new Map(modsOf(item).map((mod) => [mod.text, mod.rollRange]));
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
        // The same fold again for a weapon's elemental rolls, which are inside the printed
        // `Elemental Damage:` line exactly as a local armour roll is inside `Armour:`. One list, one
        // flag: both travel to GGG as `equipment_filters` and both are loosened by the same retry, so
        // a mod folded either way is reported as searched by the same arm of `searchedMods`.
        .filter((mod) => {
          const folded =
            (active.defences && isLocalDefenceMod(mod.text, defences)) ||
            (active.weapon && isLocalElementalDamageMod(mod.text, weapon));
          if (!folded) return true;
          defenceFolded.push(mod.text);
          return false;
        })
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
      // Not the roll itself: `searchFloor` takes it partway down toward the mod's own printed
      // bracket, because demanding this item's exact roll on every mod at once asks for a strictly
      // better item and routinely matches nothing. The user's own bound still wins outright.
      const min =
        override !== undefined
          ? override.min
          : value === null
            ? null
            : searchFloor(value, rangeByMod.get(text));
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
    return { filters, modsByStat, tiersByStat, defenceFolded };
  }

  /**
   * How many of the sampled listings carried each of the item's mods.
   *
   * Counted over **every** stat the item's mods mapped to, not just the ones the winning rung sent —
   * which is where the number earns its place. A rung is an `and`, so every listing it returned
   * carries all of its enabled filters and the count for those is necessarily the whole sample. The
   * mods the ladder *dropped* are the interesting column: how many of the listings this price came
   * from happen to carry them anyway is what says whether dropping them cost anything.
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
    mapFilters: MapFilter[],
    /**
     * Where this search sits in its lookup, for the log alone — "rung 1/3", or which retry it is.
     *
     * Worth a parameter because without it two lookups over the same base are indistinguishable from
     * one lookup walking two rungs, which is exactly the confusion that prompted it: an automatic
     * price and a later Reprice print adjacent lines that read as one descending ladder.
     */
    stage: string
  ): Promise<RungResult | { failure: { estimate: TradeEstimate; transient: boolean } }> {
    // Both filter groups live under one `query.filters` key, so they have to be assembled together
    // rather than each conditionally spreading its own — the second would replace the first.
    const queryFilters: Record<string, unknown> = {};
    // Accumulated rather than assigned, for the same reason the groups below are assembled into one
    // object: corrupted and ilvl are both misc filters, and a second assignment would drop the first.
    const miscFilters: Record<string, unknown> = {};
    if (item.corrupted) {
      miscFilters.corrupted = { option: "true" };
    }
    // A white base is worth what its item level makes it worth, so that is the one thing to ask for —
    // and it is asked for **exactly**, with no ratio below it. Item level is a discrete breakpoint
    // (81 and 82 are different markets) rather than a continuous stat, so the defenceMinRatio-style
    // widening used everywhere else would land far below the thing giving this base its value.
    if (item.rarity === "Normal" && item.itemLevel !== null) {
      miscFilters.ilvl = { min: item.itemLevel };
    }
    if (Object.keys(miscFilters).length > 0) {
      queryFilters.misc_filters = { filters: miscFilters };
    }
    // Without this the search for "Sacred Focus" matches every *rare* on that base as well, and a
    // white item gets priced off rare listings. The base type alone does not separate the two, and
    // this is the only filter that does.
    if (item.rarity === "Normal") {
      queryFilters.type_filters = { filters: { rarity: { option: "normal" } } };
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
        filters: Object.fromEntries(
          mapFilters.map(({ id, min, max }) => [
            id,
            { ...(min !== undefined && { min }), ...(max !== undefined && { max }) }
          ])
        )
      };
    }
    // Only the opt-out is ever sent. Omitting `sale_type` *is* buyout-or-fixed-price — GGG's filter
    // reference gives that option a `null` id, meaning the state the dropdown is in when nothing is
    // sent, and sending `{ option: null }` explicitly is a 400. Measured on a live search: omitted
    // 239 listings, `unpriced` 93, `any` 332. See `trade2.saleType`.
    // Accumulated, like `misc_filters` above: the sale type and the price floor are both trade
    // filters, and assigning the group twice would drop whichever came first.
    const tradeFilters: Record<string, unknown> = {};
    if (this.settings.trade2.saleType === "any") {
      tradeFilters.sale_type = { option: "any" };
    }
    // The floor goes to GGG rather than being applied to the fetched sample, and that is load-bearing:
    // `priceSample` takes the *cheapest* `maxListings` matches, so a floor applied afterwards finds every
    // one of them below it and leave nothing to price.
    //
    // **It carries no `option`, and that is the whole point.** `option` names the currency a listing
    // is *priced in*, not a unit to compare against — so the `{ min: 1, option: "exalted" }` this used
    // to send meant "listings quoted in exalted orbs, at least 1" and silently discarded every
    // divine-priced listing, which is the entire expensive end of any market. Measured on one real
    // jewel query whose two matches were quoted at 1 and 10 divine:
    //
    //     { min: 1,      option: "exalted" } -> 0     { min: 1, option: "divine" } -> 2
    //     { min: 0.0001, option: "exalted" } -> 0     { min: 1 }                   -> 2
    //     { min: 999999 }                    -> 0     { min: 3000 }                -> 1
    //
    // A bare `min` is honoured and compares across currencies, so it is the only correct form. The
    // unit is GGG's own normalisation and it is not poe.ninja's: those last two rows put one divine
    // between 400 and 3000 of it, where poe.ninja's rate would say 347 exalted. Close enough to
    // exalted that the default of 1 still means roughly what it reads as, but don't document it as
    // exalted, and don't reintroduce the currency to make the wording tidier.
    if (this.settings.trade2.minListingPrice > 0) {
      tradeFilters.price = { min: this.settings.trade2.minListingPrice };
    }
    if (Object.keys(tradeFilters).length > 0) {
      queryFilters.trade_filters = { filters: tradeFilters };
    }

    // Two sibling groups, the item's own mods at index 0 and the derived aggregates after it. The
    // aggregates stay a group of their own rather than joining the first because they are the item's
    // headline numbers — an 83% total resistance ring is not comparable to one without it, whatever
    // else matched — and because folding them in would shift every ladder threshold and every
    // reported mod count. Confirmed against the live API: two `stats` groups side by side answer 200.
    const statGroups: unknown[] = [];
    if (statFilters.length > 0) {
      // **`and`, never `count`.** Every rung demands all of its own filters, and this is the shape
      // that says so directly. It used to be `count` with `min` equal to the number of *enabled*
      // filters — arithmetically the same demand, but written in the shape that used to relax, which
      // left the reader (and GGG) to work out whether a `disabled: true` filter counted toward the
      // threshold. `and` has no threshold to count toward: enabled filters are required, disabled
      // ones are ignored, which is the behaviour verified live for both group types.
      //
      // The count axis stays gone. "At least N of these M" prices an item that isn't this one and
      // cannot report which, since different listings satisfy different subsets — see `searchRungs()`
      // and the `statCoverage` notes. Relaxation happens by dropping named mods, and only that way.
      statGroups.push({ type: "and", filters: statFilters });
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
    const priceNote = this.describePriceFloor();
    const defenceNote = defenceFilters.length > 0 ? ` and ${describeDefences(defenceFilters)}` : "";
    const mapNote = mapFilters.length > 0 ? ` and ${describeMapFilters(mapFilters)}` : "";
    const pseudoNote =
      pseudoFilters.length > 0
        ? ` and ${pseudoFilters.map((filter) => `${filter.value?.min ?? "any"}+ ${filter.id.replace("pseudo.pseudo_", "")}`).join(", ")}`
        : "";
    // The item's own name as well as its base: a base type alone is ambiguous the moment two rares
    // of the same base are priced in one session, and it is the name every other line uses.
    console.log(
      `[trade2] "${item.name}" (${item.baseType}) ${stage} with ${required} of ${statFilters.length} ` +
        `mod filter(s)${priceNote}${defenceNote}${pseudoNote}${mapNote}: ${rung.total} listing(s)`
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
    autoDroppedMods: string[],
    searchedMods: string[]
  ): Promise<{ estimate: TradeEstimate; transient: boolean }> {
    const ids = priceSample(rung.ids, Math.min(this.settings.trade2.maxListings, MAX_FETCH_IDS));

    const fetchResponse = await this.gggFetch(
      `${API_BASE}/fetch/${ids.join(",")}?query=${encodeURIComponent(rung.searchId)}&realm=${REALM}`
    );
    if (!fetchResponse.ok) {
      return this.describeHttpFailure(fetchResponse, "fetch");
    }

    const fetchBody = (await fetchResponse.json()) as { result: TradeListing[] };
    // The seller's own quote travels alongside its converted value rather than being mapped away,
    // because the cheapest listing's currency is what the row is displayed in — see
    // `PricedItem.tradeListingQuote`. Pairing them is the whole reason this isn't a flat `.map()`:
    // the sort below is on the chaos figure, and the quote has to survive it attached to its own.
    const priced = fetchBody.result
      .map((entry) => ({
        price: entry.listing.price,
        // Parsed here, at the only point the raw listing is in scope. `Date.parse` returns NaN
        // rather than throwing on a missing or malformed value, and NaN is filtered to `undefined`
        // below — an unusable date has to reach the row as "say nothing", never as a wrong number.
        indexedAt: entry.listing.indexed ? Date.parse(entry.listing.indexed) : Number.NaN
      }))
      .filter(
        (entry): entry is { price: { amount: number; currency: string }; indexedAt: number } =>
          entry.price !== null
      )
      // Rebuilt to the named fields rather than kept whole: GGG's price object also carries a `type`
      // ("~b/o"), and this one is persisted into `loot-cache.json`, where anything beyond what the
      // display needs is a field nothing reads and everything has to keep tolerating.
      .map(({ price, indexedAt }) => ({
        chaos: toChaos(price.amount, price.currency),
        quote: { amount: price.amount, currency: price.currency },
        indexedAt: Number.isFinite(indexedAt) ? indexedAt : undefined
      }))
      .filter(
        (entry): entry is { chaos: number; quote: ListingQuote; indexedAt: number | undefined } =>
          entry.chaos !== null
      );

    if (priced.length === 0) {
      return definitive(
        `${fetchBody.result.length} listing(s) found but none had a price this app could convert ` +
          "to chaos (unpriced stash tabs, or a currency poe.ninja isn't tracking)",
        "unconvertible"
      );
    }

    // The reported price is the **floor** of the cheap window `priceSample` selected — the cheapest
    // listing, i.e. what you can undercut into today.
    //
    // Re-sorted rather than trusting GGG's order, because the ids came back sorted by GGG's own
    // cross-currency normalisation while these are this app's chaos conversions, which can disagree.
    // This sort is what makes `priced[0]` the cheapest, which the price, its quote and its date all
    // read from — they have to describe one listing or the row annotates a number with another
    // seller's details.
    priced.sort((a, b) => a.chaos - b.chaos);
    return {
      estimate: {
        chaosValue: priced[0]!.chaos,
        // The cheapest listing's own asking price, which is the one the headline figure is.
        listingQuote: priced[0]!.quote,
        // And when that same listing went up, which is how old the headline actually is.
        listingIndexedAt: priced[0]!.indexedAt,
        // The rest of the window the headline was the floor of, in the same order. Mapped down to
        // the two fields a reader needs rather than kept whole: this is persisted into
        // `loot-cache.json`, and the quotes are display labels for one listing, which every listing
        // below the cheapest is not.
        listingSample: priced.map(({ chaos, indexedAt }) => ({ chaos, indexedAt })),
        reason: null,
        failure: null,
        listings: priced.length,
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
        autoDroppedMods,
        searchedMods
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
          "lower trade2.maxSearchesPerWindow in settings if this keeps happening",
        "rateLimited"
      );
    }
    const body = (await response.json().catch(() => null)) as GggErrorBody | null;
    const detail = body?.error ? `: ${body.error.message} (code ${body.error.code})` : "";
    const reason = `trade2 ${stage} returned HTTP ${response.status}${detail}`;
    // 5xx is GGG being briefly unwell; 4xx means the query itself was rejected and will be again.
    return {
      estimate: noPrice(reason, "searchFailed"),
      transient: response.status >= 500
    };
  }
}
