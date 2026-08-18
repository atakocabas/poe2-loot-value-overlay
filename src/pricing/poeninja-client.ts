import type { Settings } from "../shared/settings";
import { appUserAgent } from "./ggg-fetch";
import type { ParsedItem } from "../shared/types";
import type { CurrencyRates } from "../shared/format-value";

interface EconomyCore {
  rates: Record<string, number>;
  primary: string;
  secondary: string;
}

interface ItemOverviewLine {
  name: string;
  baseType: string;
  primaryValue: number;
}

interface ExchangeOverviewLine {
  id: string;
  primaryValue: number;
}

/**
 * poe.ninja's exchange endpoint returns only short slug ids (`"omen-of-chaotic-monsters"`), never
 * display names, and its `core.items[]` block only describes the three currencies used for rate
 * conversion — so there is no id->name metadata to read anywhere in the response.
 *
 * The lookup is therefore inverted: `slugify()` turns the clipboard's item name into poe.ninja's
 * id. That reconstructs the id exactly for essences, runes, fragments, omens, catalysts and soul
 * cores ("Countess Seske's Rune of Archery" -> "countess-seskes-rune-of-archery").
 *
 * This table exists **only** for the Currency category, whose ids are irregular abbreviations that
 * slugify can't produce ("Orb of Alchemy" -> "alch", not "orb-of-alchemy"). Don't extend it with
 * anything slugify already handles — check the real id first, since a wrong entry here fails
 * silently and leaves the item unpriced.
 */
const IRREGULAR_CURRENCY_IDS: Record<string, string> = {
  "chaos orb": "chaos",
  "divine orb": "divine",
  "exalted orb": "exalted",
  "regal orb": "regal",
  "vaal orb": "vaal",
  "orb of alchemy": "alch",
  "orb of chance": "chance",
  "orb of transmutation": "transmute",
  "orb of augmentation": "aug",
  "orb of annulment": "annul",
  "mirror of kalandra": "mirror",
  "artificer's orb": "artificers",
  "glassblower's bauble": "bauble",
  "gemcutter's prism": "gcp",
  "scroll of wisdom": "wisdom",
  "armourer's scrap": "scrap",
  "blacksmith's whetstone": "whetstone",
  "arcanist's etcher": "etcher"
};

/** Combining marks NFD decomposes an accent into, so stripping them leaves the plain letter. */
const COMBINING_MARKS = /\p{Mn}/gu;

/**
 * Turns a display name into poe.ninja's slug id: "Perfect Essence of Battle" ->
 * "perfect-essence-of-battle". Accents are folded, so "Oisín's Oath" -> "oisins-oath".
 *
 * The folding is not cosmetic. Without it `í` is not in `[a-z0-9]` and becomes a separator, so the
 * name came out as "ois-ns-oath" and the item went unpriced with a diagnostic that looked like a
 * missing category rather than a mangled id.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Both spellings of a slug, because **poe.ninja is not consistent about accents in its own ids**.
 * Measured against the live Runes of Aldur data, one category holds both:
 *
 * - `oisins-oath` — folded, so `slugify()` alone is right
 * - `mórrigans-insight` — accent kept, so `slugify()` alone misses it
 *
 * Nothing in the response says which convention an id follows, and there is no id->name metadata to
 * check against, so both are tried. Pure ASCII names produce one candidate and are unaffected.
 */
export function slugVariants(name: string): string[] {
  const folded = slugify(name);
  // NFC because poe.ninja's ids are composed ("ó" as one code point) and a decomposed clipboard
  // name would compare unequal to them despite reading identically.
  const literal = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return folded === literal ? [folded] : [folded, literal];
}

function nameKey(name: string, baseType: string): string {
  return `${name.toLowerCase()}|${baseType.toLowerCase()}`;
}

/**
 * Splits a trailing level/tier out of an item's name: "Uncut Support Gem (Level 5)" ->
 * `{ base: "Uncut Support Gem", level: 5 }`.
 *
 * PoE2 writes these into the *name* rather than as a property line — the same shape as
 * "Waystone (Tier 5)" — while poe.ninja builds its id from the bare name plus the level
 * ("uncut-support-gem-5"). Slugifying the whole name yields "uncut-support-gem-level-5" and
 * silently matches nothing, which is how uncut gems went unpriced. The number here is also the
 * more reliable level source, since these items don't always carry a separate `Level:` line.
 *
 * Names with no such suffix come back unchanged, so no other category is affected.
 */
export function splitLevelSuffix(name: string): { base: string; level: number | null } {
  const match = name.match(/^(.*?)\s*\((?:Level|Tier)\s+(\d+)\)\s*$/i);
  return match ? { base: match[1], level: Number(match[2]) } : { base: name, level: null };
}

/** Which of the two caches a candidate key should be looked up in. */
type LookupCandidate = { source: "byId" | "byName"; key: string };

/** Used when `poeNinja.maxConcurrentRequests` is missing or unusable. Matches the shipped default. */
const DEFAULT_POE_NINJA_CONCURRENCY = 4;

/** What each of the two category fetches reduces its response to, named so both can share one pool. */
type ItemPrice = { name: string; baseType: string; chaosValue: number };
type ExchangePrice = { id: string; chaosValue: number };

export class PoeNinjaClient {
  /** Item-overview prices, keyed by both `name|baseType` and name alone. */
  private priceByName = new Map<string, number>();
  /** Exchange prices, keyed by poe.ninja's own slug id. */
  private priceById = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Conversion rates from the last successful response. Read by the renderer to show values in
   * exalted/divine — chaos is the storage unit, not a unit anyone quotes prices in.
   */
  private rates: CurrencyRates | null = null;
  private lastRefreshAt: number | null = null;
  private refreshListeners: Array<() => void> = [];

  /** null until poe.ninja first answers; consumers must show the raw chaos figure until then. */
  getRates(): CurrencyRates | null {
    return this.rates;
  }

  /** Epoch ms of the last response that yielded prices, for the staleness indicator. */
  getLastRefreshAt(): number | null {
    return this.lastRefreshAt;
  }

  onRefresh(listener: () => void): void {
    this.refreshListeners.push(listener);
  }

  /** Built once: the version and contact don't change while the app is running. */
  private readonly userAgent: string;

  constructor(
    private readonly settings: Settings,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.userAgent = appUserAgent(settings);
  }

  startAutoRefresh(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.settings.poeNinja.refreshIntervalMs);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async refresh(): Promise<void> {
    const itemTypes = this.settings.poeNinja.itemOverviewTypes;
    const exchangeTypes = this.settings.poeNinja.exchangeOverviewTypes;

    // Run through a small pool rather than `Promise.allSettled` over the lot. A refresh is 23
    // categories, and firing all 23 at once is a burst that poe.ninja — a free community service
    // behind Cloudflare, publishing no rate limits and no `X-Rate-Limit-*` headers to react to —
    // has every reason to treat as abusive. The pool costs the refresh nothing that matters: it
    // runs on a 10-minute timer and nothing waits on it.
    //
    // **One pool over both lists, not one each.** Two pools under a `Promise.all` would each honour
    // the limit while the refresh ran at twice it — measured at 8 requests in flight for a
    // configured 4 — which makes the setting quietly mean something other than what it says.
    const tasks = [
      ...itemTypes.map((type) => ({ kind: "item" as const, type })),
      ...exchangeTypes.map((type) => ({ kind: "exchange" as const, type }))
    ];
    const settled = await this.inPool(
      tasks,
      (task): Promise<ItemPrice[] | ExchangePrice[]> =>
        task.kind === "item" ? this.fetchItemOverview(task.type) : this.fetchExchangeOverview(task.type)
    );

    // `inPool` preserves input order, so the two halves split where the item types end. Cast because
    // the union is only needed to put both fetches in one pool; each half's element type is known.
    const itemResults = settled.slice(0, itemTypes.length) as PromiseSettledResult<ItemPrice[]>[];
    const exchangeResults = settled.slice(itemTypes.length) as PromiseSettledResult<ExchangePrice[]>[];

    const counts: string[] = [];

    // Cheapest-wins for same-name uniques is resolved within a single refresh and only then merged
    // over the live cache. Comparing against the previous cycle's value instead would ratchet every
    // price permanently downwards, and merging (rather than replacing) means a category that failed
    // to fetch keeps its last known prices instead of vanishing from the overlay.
    const nameOnly = new Map<string, number>();

    itemTypes.forEach((type, index) => {
      const result = itemResults[index];
      if (result.status === "rejected") {
        console.warn(`[poe.ninja] item overview "${type}" failed:`, result.reason);
        return;
      }
      counts.push(`${type} ${result.value.length}`);
      this.warnIfEmpty(type, result.value.length);

      for (const { name, baseType, chaosValue } of result.value) {
        if (baseType) this.priceByName.set(nameKey(name, baseType), chaosValue);
        const seen = nameOnly.get(name.toLowerCase());
        if (seen === undefined || chaosValue < seen) nameOnly.set(name.toLowerCase(), chaosValue);
      }
    });

    for (const [name, chaosValue] of nameOnly) this.priceByName.set(name, chaosValue);

    exchangeTypes.forEach((type, index) => {
      const result = exchangeResults[index];
      if (result.status === "rejected") {
        console.warn(`[poe.ninja] exchange overview "${type}" failed:`, result.reason);
        return;
      }
      counts.push(`${type} ${result.value.length}`);
      this.warnIfEmpty(type, result.value.length);

      for (const { id, chaosValue } of result.value) this.priceById.set(id, chaosValue);
    });

    // Only counts as a refresh if something actually came back, so the staleness indicator keeps
    // reporting the age of the prices in use rather than the age of the last failed attempt.
    if (counts.length > 0) {
      this.lastRefreshAt = Date.now();
      for (const listener of this.refreshListeners) listener();
    }

    if (counts.length > 0) console.log(`[poe.ninja] ${counts.join(", ")}`);
    console.log(
      `[poe.ninja] refreshed price data (${this.priceByName.size + this.priceById.size} prices cached) ` +
        `for league "${this.settings.league}"`
    );
  }

  /**
   * Every key a lookup probes, most specific first. `getChaosValueForItem()`, `getChaosValue()`
   * and `describeLookup()` all walk this one list, so the "tried these ids" diagnostic can never
   * disagree with what the lookup actually did.
   *
   * Ordering, and why each step exists:
   * 1. `name-level` in the exchange cache — uncut gems get a separate id per level
   *    (`uncut-skill-gem-16` vs `uncut-skill-gem-20`, a ~2500x spread), so a name-only lookup for
   *    them isn't merely imprecise, it misses. Namespaced by full name, so nothing else collides.
   * 2. `name|baseType` — poe.ninja lists three "The Sentry" quarterstaves from 0.02c to 0.96c, so
   *    a name-only lookup would pick one arbitrarily.
   * 3. name alone — holds the *cheapest* same-name variant, so an unrecognised base under-reports
   *    rather than over-reports.
   * 4. irregular currency abbreviation, then 5. the slugified name — both spellings of it, since
   *    poe.ninja's own ids disagree on whether accents are folded (see `slugVariants`).
   */
  private lookupCandidates(
    item: Pick<ParsedItem, "name" | "baseType" | "gemLevel" | "itemLevel">
  ): LookupCandidate[] {
    const { base, level: nameLevel } = splitLevelSuffix(item.name);
    const level = nameLevel ?? item.gemLevel ?? item.itemLevel;
    const lowerName = item.name.toLowerCase();
    const candidates: LookupCandidate[] = [];

    if (level !== null) {
      for (const slug of slugVariants(base)) {
        candidates.push({ source: "byId", key: `${slug}-${level}` });
      }
    }
    // The composite key is only ever written for item-overview entries, which always have a base
    // distinct from the name. Probing "orb of alchemy|orb of alchemy" can't match, and it made the
    // unpriced diagnostic read like a bug.
    if (item.baseType && item.baseType !== item.name) {
      candidates.push({ source: "byName", key: nameKey(item.name, item.baseType) });
    }
    candidates.push({ source: "byName", key: lowerName });

    const irregularId = IRREGULAR_CURRENCY_IDS[lowerName];
    if (irregularId !== undefined) candidates.push({ source: "byId", key: irregularId });
    for (const slug of slugVariants(item.name)) candidates.push({ source: "byId", key: slug });

    return candidates;
  }

  private probe(candidates: LookupCandidate[]): number | null {
    for (const { source, key } of candidates) {
      const value = source === "byId" ? this.priceById.get(key) : this.priceByName.get(key);
      if (value !== undefined) return value;
    }
    return null;
  }

  /** Chaos value for a parsed item, or null if poe.ninja doesn't list it. */
  getChaosValueForItem(item: ParsedItem): number | null {
    return this.probe(this.lookupCandidates(item));
  }

  /**
   * Name-only entry point, kept for callers that have no parsed item (currency conversion of a
   * trade listing). Prefer `getChaosValueForItem()` where a `ParsedItem` is available.
   */
  getChaosValue(name: string, baseType?: string): number | null {
    return this.probe(
      this.lookupCandidates({ name, baseType: baseType ?? "", gemLevel: null, itemLevel: null })
    );
  }

  /**
   * What a lookup for this item tried and how much data it had to try against — the raw material
   * for the "why is this unpriced" log line. A miss with 0 entries loaded is a cold cache; a miss
   * with thousands loaded and an obviously-wrong key is a mapping bug.
   */
  describeLookup(item: ParsedItem): { keysTried: string[]; entriesLoaded: number } {
    return {
      keysTried: this.lookupCandidates(item).map((candidate) => candidate.key),
      entriesLoaded: this.priceByName.size + this.priceById.size
    };
  }

  /**
   * An unknown `type` is answered with HTTP 200 and `{"lines":[]}` rather than an error, so a
   * renamed or mistyped category would otherwise disappear in silence — which is exactly how
   * omens (category "Ritual") went unpriced unnoticed.
   */
  private warnIfEmpty(type: string, count: number): void {
    if (count === 0) {
      console.warn(`[poe.ninja] "${type}" returned no lines — is that still a valid category name?`);
    }
  }

  /**
   * Runs `work` over `items` at most `maxConcurrentRequests` at a time, settling rather than
   * rejecting — the shape `Promise.allSettled` gave, which the caller relies on to keep a failed
   * category's previous prices instead of losing the whole refresh to one bad response.
   */
  private async inPool<T, R>(
    items: readonly T[],
    work: (item: T) => Promise<R>
  ): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = [];
    // Guarded, not trusted. `mergeWithDefaults` supplies this for any real install, but an absent or
    // hand-mangled value makes `Math.max(1, undefined)` NaN, `slice(0, NaN)` empty and the loop exit
    // on its first pass — a refresh that fetches nothing, reports nothing and looks like poe.ninja
    // being down. A wrong number here must cost concurrency, never the whole refresh.
    const configured = this.settings.poeNinja.maxConcurrentRequests;
    const limit =
      Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DEFAULT_POE_NINJA_CONCURRENCY;

    for (let start = 0; start < items.length; start += limit) {
      const batch = items.slice(start, start + limit);
      results.push(...(await Promise.allSettled(batch.map(work))));
    }
    return results;
  }

  private async fetchJson(url: URL, label: string): Promise<{ core?: EconomyCore; lines?: unknown[] }> {
    const response = await this.fetchImpl(url, {
      headers: {
        accept: "application/json",
        // poe.ninja is not GGG and this is not `createPublicGggFetch` — there are no rate-limit
        // headers here to react to, and no policy requiring this. It is sent for the reason the
        // policy exists: an anonymous client hammering a free service is the one that gets blocked
        // by IP, and there is otherwise nothing in the request naming the app or its version.
        "User-Agent": this.userAgent
      }
    });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return (await response.json()) as { core?: EconomyCore; lines?: unknown[] };
  }

  /**
   * `primaryValue` is denominated in `core.primary` (divine) and `core.rates[core.secondary]` is
   * chaos-per-divine, so the product is chaos: Chaos Orb itself comes back as 0.1276 * 7.83 = 1.0.
   *
   * Throws rather than defaulting to 1 when the rate is missing: a rate of 1 stores raw *divine*
   * values as if they were chaos, understating every price in the category by ~8x, and does it
   * silently. Throwing lands in `Promise.allSettled`, which keeps the category's previous prices.
   */
  private chaosRateOf(core: EconomyCore): number {
    const rate = core.rates[core.secondary];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(
        `missing chaos conversion rate (core.rates["${core.secondary}"] = ${JSON.stringify(rate)})`
      );
    }
    return rate;
  }

  /**
   * Every category response repeats the same `core` block, so this just keeps the most recent one.
   * Only recorded when both rates are usable — a half-filled table would render exalted values as
   * NaN, which is worse than falling back to raw chaos.
   */
  private recordRates(core: EconomyCore, chaosPerDivine: number): void {
    const exaltedPerDivine = core.rates.exalted;
    if (typeof exaltedPerDivine !== "number" || !Number.isFinite(exaltedPerDivine) || exaltedPerDivine <= 0) {
      return;
    }
    this.rates = { chaosPerDivine, exaltedPerDivine };
  }

  private async fetchItemOverview(
    type: string
  ): Promise<Array<{ name: string; baseType: string; chaosValue: number }>> {
    const url = new URL(`${this.settings.poeNinja.baseUrl}/stash/current/item/overview`);
    url.searchParams.set("league", this.settings.league);
    url.searchParams.set("type", type);

    // poe.ninja returns just {"lines":[]} with no "core" block when a league/type has no
    // market data yet, so both fields need to be treated as optional.
    const body = await this.fetchJson(url, `item overview "${type}"`);
    if (!body.core || !body.lines) return [];

    const chaosRate = this.chaosRateOf(body.core);
    this.recordRates(body.core, chaosRate);
    return (body.lines as ItemOverviewLine[]).map((line) => ({
      name: line.name,
      baseType: line.baseType,
      chaosValue: line.primaryValue * chaosRate
    }));
  }

  private async fetchExchangeOverview(type: string): Promise<Array<{ id: string; chaosValue: number }>> {
    const url = new URL(`${this.settings.poeNinja.baseUrl}/exchange/current/overview`);
    url.searchParams.set("league", this.settings.league);
    url.searchParams.set("type", type);

    const body = await this.fetchJson(url, `exchange overview "${type}"`);
    if (!body.core || !body.lines) return [];

    const chaosRate = this.chaosRateOf(body.core);
    this.recordRates(body.core, chaosRate);
    return (body.lines as ExchangeOverviewLine[]).map((line) => ({
      id: line.id,
      chaosValue: line.primaryValue * chaosRate
    }));
  }
}
