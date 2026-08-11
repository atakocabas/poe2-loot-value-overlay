import type { Settings } from "../shared/settings";
import type { ParsedItem } from "../shared/types";
import { metadataIdForName } from "./exchange-metadata-ids";

/** One hourly digest as returned by GGG's Currency Exchange endpoint. */
export interface ExchangeMarket {
  league: string;
  market_id: string;
  market_pair: [string, string] | string[];
  volume_traded?: Record<string, number>;
  lowest_ratio?: Record<string, number>;
  highest_ratio?: Record<string, number>;
}

export interface ExchangeDigest {
  next_change_id: number;
  markets?: ExchangeMarket[];
}

export const CHAOS_ID = "Metadata/Items/Currency/CurrencyRerollRare";
export const DIVINE_ID = "Metadata/Items/Currency/CurrencyModValues";
export const EXALTED_ID = "Metadata/Items/Currency/CurrencyAddModToRare";

const HOUR_SECONDS = 3600;

export interface ChaosIndexEntry {
  chaosValue: number;
  /** Units of this item traded across every hour that fed the index — the confidence signal. */
  volume: number;
}

export interface ChaosIndex {
  entries: Map<string, ChaosIndexEntry>;
  chaosPerDivine: number | null;
  chaosPerExalted: number | null;
}

/**
 * Price of `a` denominated in `b` for one market, or null if this market doesn't quote both sides.
 *
 * The feed publishes an integer ratio pair normalized so the quote side is 1 — the chaos/divine
 * market reads `lowest_ratio {chaos: 4, divine: 1}`, `highest_ratio {chaos: 5, divine: 1}` — so the
 * price of one unit of `a` is `ratio[b] / ratio[a]`.
 *
 * The hour's low and high are collapsed with a **geometric** mean, which is the right centre for a
 * ratio range: a thin market can span 6..28 per divine in a single hour, where the arithmetic mean
 * (17) sits far above the typical trade and the geometric mean (12.96) does not. Using the
 * arithmetic mean would systematically over-report exactly the illiquid items whose prices are
 * least trustworthy to begin with.
 */
export function centralRatio(market: ExchangeMarket, a: string, b: string): number | null {
  const low = market.lowest_ratio;
  const high = market.highest_ratio;
  if (!low?.[a] || !low?.[b] || !high?.[a] || !high?.[b]) return null;

  const value = Math.sqrt((low[b] / low[a]) * (high[b] / high[a]));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Volume-weighted mean of `a` priced in `b` across every market that quotes the pair. */
function weightedPairPrice(markets: ExchangeMarket[], a: string, b: string, minVolume: number): number | null {
  let weighted = 0;
  let totalVolume = 0;

  for (const market of markets) {
    if (!market.market_pair.includes(a) || !market.market_pair.includes(b)) continue;
    const price = centralRatio(market, a, b);
    // Weight by the *quote* side: it's the leg denominated in the currency we're pricing into, so
    // it measures how much real liquidity stands behind this particular number.
    const volume = market.volume_traded?.[b] ?? 0;
    if (price === null || volume < minVolume) continue;
    weighted += price * volume;
    totalVolume += volume;
  }

  return totalVolume > 0 ? weighted / totalVolume : null;
}

/**
 * Turns raw hourly digests into chaos-denominated prices per metadata id.
 *
 * Chaos is the app's storage unit but *not* the exchange's hub — exalted is the most-quoted
 * currency in the feed, ahead of divine, with chaos a distant third. So most items are only
 * reachable via a hub hop: price the item against whichever of chaos/divine/exalted it trades
 * with, then convert that hub to chaos. Deriving the hub rates from the exchange itself (rather
 * than borrowing poe.ninja's) is what keeps this usable as a fallback when poe.ninja is down.
 */
export function buildChaosIndex(
  markets: ExchangeMarket[],
  options: { league: string; minVolume: number }
): ChaosIndex {
  const inLeague = markets.filter((market) => market.league === options.league);
  const { minVolume } = options;

  // Bail before seeding the hubs. Chaos is trivially worth 1 chaos, but publishing that off the
  // back of zero market data would leave the index permanently non-empty and hide a league-name
  // mismatch — the one failure this data is most prone to.
  if (inLeague.length === 0) {
    return { entries: new Map(), chaosPerDivine: null, chaosPerExalted: null };
  }

  const chaosPerDivine = weightedPairPrice(inLeague, DIVINE_ID, CHAOS_ID, minVolume);
  // Exalted is cheap enough that exalted/chaos markets are thinner than exalted/divine ones, so
  // fall back to bridging through divine rather than leaving every exalted-quoted item unpriced.
  const exaltedInDivine = weightedPairPrice(inLeague, EXALTED_ID, DIVINE_ID, minVolume);
  const chaosPerExalted =
    weightedPairPrice(inLeague, EXALTED_ID, CHAOS_ID, minVolume) ??
    (exaltedInDivine !== null && chaosPerDivine !== null ? exaltedInDivine * chaosPerDivine : null);

  const hubChaosValue = new Map<string, number>([[CHAOS_ID, 1]]);
  if (chaosPerDivine !== null) hubChaosValue.set(DIVINE_ID, chaosPerDivine);
  if (chaosPerExalted !== null) hubChaosValue.set(EXALTED_ID, chaosPerExalted);

  const accumulator = new Map<string, { weighted: number; volume: number }>();

  for (const market of inLeague) {
    const [left, right] = market.market_pair;
    if (!left || !right) continue;

    for (const [item, hub] of [
      [left, right],
      [right, left]
    ]) {
      const hubChaos = hubChaosValue.get(hub);
      // Skip hub-vs-hub markets: their rates are already established above, and letting them
      // through would have the hubs re-price each other inconsistently.
      if (hubChaos === undefined || hubChaosValue.has(item)) continue;

      const priceInHub = centralRatio(market, item, hub);
      const volume = market.volume_traded?.[item] ?? 0;
      if (priceInHub === null || volume < minVolume) continue;

      const current = accumulator.get(item) ?? { weighted: 0, volume: 0 };
      current.weighted += priceInHub * hubChaos * volume;
      current.volume += volume;
      accumulator.set(item, current);
    }
  }

  const entries = new Map<string, ChaosIndexEntry>();
  for (const [id, { weighted, volume }] of accumulator) {
    entries.set(id, { chaosValue: weighted / volume, volume });
  }
  for (const [id, chaosValue] of hubChaosValue) {
    entries.set(id, { chaosValue, volume: Number.POSITIVE_INFINITY });
  }

  return { entries, chaosPerDivine, chaosPerExalted };
}

/** The hour ids to request, oldest first, ending `lookbackHours` before the current hour. */
export function seedHour(nowMs: number, lookbackHours: number): number {
  const currentHour = Math.floor(nowMs / 1000 / HOUR_SECONDS) * HOUR_SECONDS;
  return currentHour - lookbackHours * HOUR_SECONDS;
}

/**
 * GGG's Currency Exchange (`web.poecdn.com/api/currency-exchange/poe2`) as a fallback price source.
 *
 * Public and unauthenticated — no OAuth, no client id, nothing to register — which is why this
 * exists at all: it is the only first-party PoE2 price data the developer API actually exposes.
 * Deliberately shaped like `PoeNinjaClient` (same injected-fetch seam, same auto-refresh lifecycle,
 * same `getChaosValueForItem`) so `PriceResolver` treats the two interchangeably.
 *
 * Two properties of the data are worth knowing before trusting a number from it: the feed is
 * **hourly aggregate history, never live** (GGG's reference states there is no current-hour data),
 * and it only covers items traded on the currency exchange — so it cannot price rares.
 */
export class CurrencyExchangeClient {
  private index: ChaosIndex = { entries: new Map(), chaosPerDivine: null, chaosPerExalted: null };
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt: number | null = null;

  constructor(
    private readonly settings: Settings,
    // Narrower than `typeof fetch` on purpose: this only ever requests string URLs, and the
    // narrower shape is what both global `fetch` and `createPublicGggFetch()` satisfy.
    private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch
  ) {}

  /** Epoch ms of the last refresh that produced prices, or null if none has yet. */
  getLastRefreshAt(): number | null {
    return this.lastRefreshAt;
  }

  /** Hub rates derived from the exchange, for the startup sanity check against poe.ninja. */
  getDerivedRates(): { chaosPerDivine: number | null; chaosPerExalted: number | null } {
    return { chaosPerDivine: this.index.chaosPerDivine, chaosPerExalted: this.index.chaosPerExalted };
  }

  startAutoRefresh(): void {
    if (!this.settings.currencyExchange.enabled) {
      console.log("[exchange] disabled in settings");
      return;
    }
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.settings.currencyExchange.refreshIntervalMs);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async refresh(): Promise<void> {
    const config = this.settings.currencyExchange;
    const league = config.leagueOverride || this.settings.league;

    let hourId = seedHour(Date.now(), config.lookbackHours);
    const markets: ExchangeMarket[] = [];

    for (let page = 0; page < config.maxPagesPerRefresh; page++) {
      let digest: ExchangeDigest;
      try {
        digest = await this.fetchDigest(hourId);
      } catch (error) {
        console.warn(`[exchange] hour ${hourId} failed:`, error);
        break;
      }

      if (digest.markets) markets.push(...digest.markets);

      // The reference signals end-of-stream by echoing back the id you asked for; without this the
      // loop would keep re-requesting the same (not yet published) hour until maxPages runs out.
      if (!digest.next_change_id || digest.next_change_id === hourId) break;
      hourId = digest.next_change_id;
    }

    if (markets.length === 0) {
      console.warn("[exchange] no markets returned — leaving previous prices in place");
      return;
    }

    const index = buildChaosIndex(markets, { league, minVolume: config.minVolume });
    if (index.entries.size === 0) {
      // Almost always a league-name mismatch: the feed carries every league in the realm, so a
      // typo'd or ended league silently filters everything out.
      console.warn(
        `[exchange] ${markets.length} markets fetched but none in league "${league}" — ` +
          "check settings.league, or set currencyExchange.leagueOverride"
      );
      return;
    }

    this.index = index;
    this.lastRefreshAt = Date.now();
    console.log(
      `[exchange] ${index.entries.size} prices from ${markets.length} markets in "${league}" ` +
        `(chaos/divine ${index.chaosPerDivine?.toFixed(2) ?? "?"}, ` +
        `chaos/exalted ${index.chaosPerExalted?.toFixed(4) ?? "?"})`
    );
  }

  /** Chaos value for a parsed item, or null if it isn't mapped or isn't traded. */
  getChaosValueForItem(item: ParsedItem): number | null {
    const metadataId = metadataIdForName(item.name);
    if (metadataId === null) return null;
    return this.index.entries.get(metadataId)?.chaosValue ?? null;
  }

  /** Why a lookup missed — the raw material for the "unpriced" diagnostic. */
  describeLookup(item: ParsedItem): { metadataId: string | null; entriesLoaded: number } {
    return { metadataId: metadataIdForName(item.name), entriesLoaded: this.index.entries.size };
  }

  private async fetchDigest(hourId: number): Promise<ExchangeDigest> {
    const { baseUrl, realm } = this.settings.currencyExchange;
    const response = await this.fetchImpl(`${baseUrl}/${realm}/${hourId}`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as ExchangeDigest;
  }
}
