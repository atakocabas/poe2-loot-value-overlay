import type { Settings } from "../shared/settings";
import type { ItemDefences, ParsedItem } from "../shared/types";
import { createPublicGggFetch, type GggFetch } from "./ggg-fetch";
import { modsOf } from "../shared/mods";
import { defencesOf, isLocalDefenceMod } from "../shared/defences";
import { TradeStatsMatcher } from "./trade-stats";
import { TradeSearchBudget } from "./trade-budget";

const API_BASE = "https://www.pathofexile.com/api/trade2";
const REALM = "poe2";
/** More than 10 ids in one fetch call is answered with `400 {"error":{"code":2,...}}`. */
const MAX_FETCH_IDS = 10;

interface TradeListing {
  listing: {
    price: { amount: number; currency: string } | null;
  };
}

interface GggErrorBody {
  error?: { code: number; message: string };
}

/** One mod as trade2 asks for it. `value` is omitted for stats GGG indexes without a number. */
interface StatFilter {
  id: string;
  value?: { min: number };
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
  chaosValue: number | null;
  /** Why there is no value. null when `chaosValue` is set. */
  reason: string | null;
  /** How many listings the median was taken over — the sample, not the whole match set. */
  listings: number;
  /** How many online listings the search matched in total, which the sample is drawn from. */
  matches: number;
  /** How many of the item's mods the priced listings were required to share. */
  matchedMods: number;
  /** How many mod filters the item produced. `matchedMods < totalMods` means the search relaxed. */
  totalMods: number;
  /**
   * What each threshold the ladder tried actually matched, strictest first. Kept so a caller can
   * say *why* a stricter rung was passed over — "nothing carries all four mods" and "one listing
   * does, which is too thin to be a price" call for different things from the user.
   */
  rungs: Array<{ required: number; total: number }>;
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function noPrice(reason: string): TradeEstimate {
  return {
    chaosValue: null,
    reason,
    listings: 0,
    matches: 0,
    matchedMods: 0,
    totalMods: 0,
    rungs: [],
    defences: [],
    defencesDropped: false
  };
}

/** "973+ Armour, 216+ Evasion" — how a defence constraint is named in a message. */
export function describeDefences(defences: DefenceFilter[]): string {
  const labels: Record<string, string> = { ar: "Armour", ev: "Evasion", es: "Energy Shield", ward: "Ward" };
  return defences.map((filter) => `${filter.min}+ ${labels[filter.id] ?? filter.id}`).join(", ");
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
 * Which slice of the price-ascending search results to actually fetch a price from.
 *
 * The obvious slice — the first `size`, the cheapest listings — is the one this used to take, and it
 * reports the *market floor* rather than a price. PoE2 trade's cheap end is a wall of 1-exalted dump
 * listings, so for anything with more than `size` listings the answer came back as 1 exalted no
 * matter what the item was. Measured on a real four-mod Ruby jewel (236 matching online listings,
 * search returned the 100 cheapest ids):
 *
 * | ids taken | prices seen |
 * |---|---|
 * | 0-9 (what this used to do) | ten straight `1 exalted` |
 * | 45-54 (the middle) | 29, 29, 30, 30, 30, 30, 30, 33, 40, 40 exalted |
 * | 90-99 (the top) | 5 chaos, 500 exalted, seven `1 divine` |
 *
 * The item was priced at 1 exalted; sellers of the same jewel were asking ~30. Taking the middle of
 * the window and the median of that lands on the same ~30 without being dragged by either the dump
 * listings below or the fantasy asking prices above.
 *
 * GGG returns at most 100 ids however many listings matched, so for a heavily-traded base this is
 * the median of the 100 cheapest rather than of the whole market — still biased low, deliberately,
 * and in the same direction as the loose mod matching above.
 */
export function medianWindow<T>(results: T[], size: number): T[] {
  if (results.length <= size) return results;
  const start = Math.floor((results.length - size) / 2);
  return results.slice(start, start + size);
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
      settings.trade2.maxSearchesPerWindow,
      settings.trade2.windowMs,
      settings.trade2.minSearchIntervalMs
    );
  }

  /** Whether lookups are switched on at all. The only remaining kill switch — there is no login. */
  get isAvailable(): boolean {
    return this.settings.trade2.enabled;
  }

  /** Which sellers were counted, so callers can word "no listings" without contradicting the query. */
  get listingStatus(): "online" | "any" {
    return this.settings.trade2.listingStatus;
  }

  /** "online listings" or plain "listings", matching what was actually searched. */
  private get listingsLabel(): string {
    return this.listingStatus === "any" ? "listings" : "online listings";
  }

  /**
   * Estimates a chaos-equivalent value for a rare item from live listings. `ignoredMods` excludes
   * specific mod lines (the row editor's checkboxes) from the search; the rest are matched against
   * GGG's public stat reference and searched as "at least this roll" filters. If none of the mods
   * can be matched, this falls back to a base-type-only search rather than failing outright.
   * `toChaos` converts a listing's currency (e.g. "divine") into chaos.
   */
  async estimateRareValue(
    item: ParsedItem,
    ignoredMods: Set<string>,
    toChaos: (amount: number, currency: string) => number | null
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

      const { estimate, transient } = await this.attempt(item, ignoredMods, toChaos);
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
    toChaos: (amount: number, currency: string) => number | null
  ): Promise<{ estimate: TradeEstimate; transient: boolean }> {
    try {
      return await this.search(item, ignoredMods, toChaos);
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
    toChaos: (amount: number, currency: string) => number | null
  ): Promise<{ estimate: TradeEstimate; transient: boolean }> {
    const defenceFilters = this.buildDefenceFilters(item);
    const statFilters = await this.buildStatFilters(item, ignoredMods, defenceFilters.length > 0);
    const ladder = modLadder(
      statFilters.length,
      this.settings.trade2.minModMatchRatio,
      this.settings.trade2.maxModLadderSearches
    );

    let best: RungResult | null = null;
    const tried: number[] = [];
    const rungs: Array<{ required: number; total: number }> = [];
    let budgetStopped = false;

    // An item whose only matchable mods were defence mods leaves no stat filters and an empty
    // ladder — but "this base with at least this much armour" is a real query and worth sending, so
    // it gets one rung at a threshold of zero rather than falling through to "no listings for base
    // type", which would be a flat lie about a search that was never run.
    const rungsToTry = ladder.length > 0 ? ladder : [0];

    for (const [step, required] of rungsToTry.entries()) {
      if (step > 0 && !(await this.spendBudgetSlot())) {
        budgetStopped = true;
        break;
      }
      tried.push(required);

      const rung = await this.searchRung(item, statFilters, required, defenceFilters);
      if ("failure" in rung) return rung.failure;
      rungs.push({ required, total: rung.total });

      if (rung.total > 0) best = rung;
      if (rung.total >= this.settings.trade2.minListingsForMatch) break;
    }

    // Nothing at any threshold *with* the defence floors. Retry the loosest rung once without them
    // before giving up: that query is exactly what this sent before defence filters existed, so it
    // can only find listings the old code would also have found — it can never invent a market. The
    // extra request is only ever spent on an item that was otherwise about to be stored unpriced.
    let defencesDropped = false;
    if (!best && !budgetStopped && defenceFilters.length > 0) {
      if (await this.spendBudgetSlot()) {
        const required = rungsToTry[rungsToTry.length - 1];
        console.log(
          `[trade2] "${item.baseType}" no listings with ${describeDefences(defenceFilters)} - ` +
            "retrying without the defence constraint"
        );
        const rung = await this.searchRung(item, statFilters, required, []);
        if ("failure" in rung) return rung.failure;
        if (rung.total > 0) {
          best = rung;
          defencesDropped = true;
        }
      } else {
        budgetStopped = true;
      }
    }

    // Named in every no-match message: without it the text blames the mods for a miss the armour
    // floor may well have caused, and points the user at unticking mods that were never the problem.
    const withDefences = defenceFilters.length > 0 ? ` with ${describeDefences(defenceFilters)}` : "";

    if (!best && budgetStopped) {
      // Distinct from "nothing matches": the looser rungs that would have priced this were never
      // sent, so the row's Reprice really will find something once the window refills.
      return definitive(
        `no ${this.listingsLabel} match this ${item.baseType}${withDefences} on ` +
          `${tried[tried.length - 1]} or more of its ${statFilters.length} mods, and the search ` +
          `budget ran out before trying fewer - retry in ` +
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
          ? `no ${this.listingsLabel} match this ${item.baseType} on ${tried[tried.length - 1]} or ` +
              `more of its ${statFilters.length} mods at these rolls (tried ${tried.join(", ")}) - ` +
              'press Edit on the row, untick the rare mods, then "Reprice via trade"'
          : `no ${this.listingsLabel} for base type "${item.baseType}"${withDefences}`
      );
    }

    return this.priceFromRung(
      best,
      statFilters.length,
      rungs,
      defencesDropped ? [] : defenceFilters,
      defencesDropped,
      toChaos
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
  private buildDefenceFilters(item: ParsedItem): DefenceFilter[] {
    if (!this.settings.trade2.useDefenceFilters) return [];

    const defences = defencesOf(item);
    const ratio = this.settings.trade2.defenceMinRatio;

    return (Object.keys(DEFENCE_FILTER_IDS) as Array<keyof ItemDefences>)
      .filter((key) => defences[key] !== null && defences[key]! > 0)
      .map((key) => ({ id: DEFENCE_FILTER_IDS[key], min: Math.floor(defences[key]! * ratio) }))
      .filter((filter) => filter.min > 0);
  }

  /** The item's mods as trade2 stat filters, summed per stat id. */
  private async buildStatFilters(
    item: ParsedItem,
    ignoredMods: Set<string>,
    defenceFiltersActive: boolean
  ): Promise<StatFilter[]> {
    const defences = defencesOf(item);
    const { matched } = await this.statsMatcher.matchMods(
      modsOf(item)
        .filter((mod) => !ignoredMods.has(mod.text))
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
    const summed = new Map<string, number | null>();
    for (const { statId, value } of matched.values()) {
      if (value === null) {
        if (!summed.has(statId)) summed.set(statId, null);
        continue;
      }
      summed.set(statId, (summed.get(statId) ?? 0) + value);
    }
    // A null threshold is asked for by presence alone. Sending `{"min": null}` instead — which is
    // what a NaN serialises to — matches nothing and takes the entire search to zero results with it.
    return [...summed].map(([id, value]) => (value === null ? { id } : { id, value: { min: value } }));
  }

  /** One search at a single mod threshold. No fetch — only the winning rung is worth spending on. */
  private async searchRung(
    item: ParsedItem,
    statFilters: StatFilter[],
    required: number,
    defenceFilters: DefenceFilter[]
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
            // `count` with a minimum, never `and`. See requiredModMatches() for why.
            ...(statFilters.length > 0
              ? { stats: [{ type: "count", value: { min: required }, filters: statFilters }] }
              : {})
          },
          // Ascending price, so the ids come back in a known order and `medianWindow` can take the
          // middle of them rather than an arbitrary slice. GGG normalises across currencies for
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
    console.log(
      `[trade2] "${item.baseType}" with ${required} of ${statFilters.length} mod filter(s)` +
        `${defenceNote}: ${rung.total} listing(s)`
    );
    return rung;
  }

  /** Fetches the winning rung's sampled listings and reduces them to one chaos value. */
  private async priceFromRung(
    rung: RungResult,
    totalMods: number,
    rungs: Array<{ required: number; total: number }>,
    defences: DefenceFilter[],
    defencesDropped: boolean,
    toChaos: (amount: number, currency: string) => number | null
  ): Promise<{ estimate: TradeEstimate; transient: boolean }> {
    const ids = medianWindow(rung.ids, Math.min(this.settings.trade2.maxListings, MAX_FETCH_IDS));

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

    // Median, not the mean, and of the middle of the result window rather than its cheap end — see
    // medianWindow() for the measurements. Both halves of that matter: PoE2 trade is full of
    // 1-exalted placeholder listings at the bottom and speculative asking prices at the top, and
    // only ignoring both gets near what the item would actually sell for.
    chaosValues.sort((a, b) => a - b);
    return {
      estimate: {
        chaosValue: chaosValues[Math.floor(chaosValues.length / 2)],
        reason: null,
        listings: chaosValues.length,
        matches: rung.total,
        matchedMods: rung.required,
        totalMods,
        rungs,
        defences,
        defencesDropped
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
