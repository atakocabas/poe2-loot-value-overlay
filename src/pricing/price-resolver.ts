import type { ParsedItem, PricedItem } from "../shared/types";
import type { PoeNinjaClient } from "./poeninja-client";
import type { CurrencyExchangeClient } from "./currency-exchange-client";
import { describeDefences, type Trade2Client } from "./trade2-client";
import { toChaos } from "./currency-convert";
import { formatNumber } from "../shared/format-value";

/**
 * Why an item ended up without a price. "unpriced" covers at least four genuinely different
 * situations — one of which is a bug and three of which are expected — and collapsing them into a
 * single log line made a broken name->id mapping indistinguishable from working as designed.
 */
function explainUnpriced(
  item: ParsedItem,
  poeNinja: PoeNinjaClient,
  exchange: CurrencyExchangeClient,
  tradeReason: string | null
): string {
  const { keysTried, entriesLoaded } = poeNinja.describeLookup(item);

  // Ordered most-fundamental first: no data at all explains every miss, so check it before
  // blaming the item.
  if (entriesLoaded === 0 || poeNinja.getLastRefreshAt() === null) {
    return (
      "poe.ninja data hasn't loaded yet (first refresh still in flight) — this item will stay " +
      "unpriced until it is repriced or given a manual value"
    );
  }

  // poe.ninja only publishes uniques and currency-likes. Rares and magic items are not a lookup
  // failure; there is nothing to look them up in.
  if (item.rarity === "Rare") {
    // trade2 was consulted, so it owns the explanation — budget spent, no listings, HTTP error.
    return `${tradeReason ?? "trade2 returned nothing"} — or set a manual price with the row's Edit button`;
  }
  if (item.rarity === "Magic") {
    // PoE2 glues prefix and suffix onto the base on one header line, so `baseType` for a Magic item
    // is the affixed name (see ParsedItem). There is no real base type to search trade2 with, which
    // is why Magic items don't take the Rare path above.
    return (
      "poe.ninja doesn't list Magic items, and their clipboard header glues the affixes onto the " +
      "base type, leaving nothing reliable to search trade2 with — set a manual price with the " +
      "row's Edit button"
    );
  }

  // The exchange is only ever consulted after poe.ninja misses, so by here it has already been
  // tried; saying which of the two ways it came up short keeps a missing table entry (fixable)
  // distinguishable from an item that simply isn't traded (not fixable).
  const { metadataId, entriesLoaded: exchangeEntries } = exchange.describeLookup(item);
  const exchangeNote =
    metadataId === null
      ? `"${item.name}" has no entry in exchange-metadata-ids.ts`
      : `not traded on the currency exchange (${metadataId}; ${exchangeEntries} priced ids loaded)`;

  return (
    `not found in poe.ninja data (tried: ${keysTried.join(", ")}; ${entriesLoaded} entries loaded), ` +
    `and ${exchangeNote}. ` +
    "If that id looks wrong, the name->id mapping needs fixing; if it looks right, the category " +
    "may not be in poeNinja.exchangeOverviewTypes"
  );
}

/**
 * Why the strictest threshold didn't produce the price, in the terms the user can act on.
 *
 * The two cases need different words and used to share one sentence. **Zero** means nobody online
 * has listed an item with all these mods — and "online" is the load-bearing word, since the same
 * search on the trade site with the status filter left at *any* shows offline sellers too. A real
 * Sapphire jewel matched 0 online listings on all four of its mods and 16 once offline ones were
 * counted, which is exactly the gap between what this reports and what the site appears to show.
 * **A handful** means someone has listed one, but a median over one or two asking prices is that
 * asking price, so the ladder went past it — the trade site is where to look at those by hand.
 */
function explainStrictMiss(
  rungs: Array<{ required: number; total: number }>,
  totalMods: number,
  status: "online" | "any"
): string {
  const label = status === "any" ? "listing(s)" : "online listing(s)";
  const strict = rungs.find((rung) => rung.required === totalMods);
  if (!strict || strict.total === 0) {
    const hint = status === "any" ? "" : " (offline sellers may - see trade2.listingStatus)";
    return `has no ${label} carrying all ${totalMods} of its mods${hint}`;
  }
  return (
    `has only ${strict.total} ${label} carrying all ${totalMods} of its mods - too few to take a ` +
    "median over"
  );
}

/** How specific the search that produced a price was, for the log line. See also describeDefences. */
function describeModMatch({ matched, total }: { matched: number; total: number }): string {
  if (total === 0) return "base type only";
  return matched >= total ? `all ${total} mods` : `only ${matched} of ${total} mods`;
}

export class PriceResolver {
  constructor(
    private readonly poeNinja: PoeNinjaClient,
    private readonly exchange: CurrencyExchangeClient,
    private readonly trade2: Trade2Client,
    private readonly stalePoeNinjaAfterMs: number
  ) {}

  /**
   * poe.ninja's prices are only trusted while they're fresh. If its last successful refresh has
   * aged out (or never happened), a cached value can be arbitrarily stale — during an outage it
   * would otherwise keep serving yesterday's numbers indefinitely, with nothing to signal it.
   */
  private poeNinjaIsStale(): boolean {
    const lastRefreshAt = this.poeNinja.getLastRefreshAt();
    // >= rather than >, so a threshold of 0 means "always stale" as the setting documents, instead
    // of depending on whether the clock happened to tick since the refresh.
    return lastRefreshAt === null || Date.now() - lastRefreshAt >= this.stalePoeNinjaAfterMs;
  }

  /**
   * `onTradeSearch` fires at the moment this stops being a cache lookup and becomes a network call —
   * the only branch here that takes long enough to be worth telling the user about. Optional, since
   * nothing but the pending indicator cares.
   */
  async resolve(
    item: ParsedItem,
    sessionId: string,
    onTradeSearch?: () => void
  ): Promise<Omit<PricedItem, "id">> {
    const base = { ...item, sessionId, ignoredMods: [], manualChaosValue: null };

    const direct = this.poeNinja.getChaosValueForItem(item);
    const stale = this.poeNinjaIsStale();
    if (direct !== null && !stale) {
      console.log(`[pricing] "${item.name}" priced via poe.ninja: ${formatNumber(direct)} chaos`);
      return { ...base, chaosValue: direct, priceSource: "poeninja" };
    }

    const fromExchange = this.exchange.getChaosValueForItem(item);
    if (fromExchange !== null) {
      const why = direct === null ? "not in poe.ninja" : "poe.ninja data is stale";
      console.log(
        `[pricing] "${item.name}" priced via currency exchange (${why}): ` +
          `${formatNumber(fromExchange)} chaos`
      );
      return { ...base, chaosValue: fromExchange, priceSource: "currencyExchange" };
    }

    // Stale-but-present beats nothing: the exchange had no opinion, so poe.ninja's aged number is
    // still the best available estimate.
    if (direct !== null) {
      console.log(
        `[pricing] "${item.name}" priced via poe.ninja (stale, no exchange fallback): ` +
          `${formatNumber(direct)} chaos`
      );
      return { ...base, chaosValue: direct, priceSource: "poeninja" };
    }

    // Rares only. The Trade2Client itself owns the enabled/budget checks, so there is exactly one
    // place that decides whether a lookup happens and exactly one place that words the refusal.
    let tradeReason: string | null = null;
    if (item.rarity === "Rare") {
      console.log(`[pricing] "${item.name}" not in poe.ninja — querying trade2...`);
      onTradeSearch?.();
      const estimate = await this.trade2.estimateRareValue(item, new Set(), (amount, currency) =>
        toChaos(this.poeNinja, amount, currency)
      );
      if (estimate.chaosValue !== null) {
        const modMatch = { matched: estimate.matchedMods, total: estimate.totalMods };
        const defenceNote =
          estimate.defences.length > 0 ? ` and ${describeDefences(estimate.defences)}` : "";
        console.log(
          `[pricing] "${item.name}" priced via trade2: ${formatNumber(estimate.chaosValue)} chaos ` +
            `(median of ${estimate.listings} sampled from ${estimate.matches} listings ` +
            `matching ${describeModMatch(modMatch)}${defenceNote})`
        );
        // Warned about separately rather than folded into the line above, because a relaxed match is
        // the difference between a price for this item and a price for its base with some mods on it.
        if (modMatch.total > 0 && modMatch.matched < modMatch.total) {
          console.warn(
            `[trade2] "${item.name}" ` +
              `${explainStrictMiss(estimate.rungs, modMatch.total, this.trade2.listingStatus)}, so this ` +
              `is a ballpark off ${modMatch.matched} of them - to narrow it, press Edit on the ` +
              'item\'s row, untick the mods to leave out, then "Reprice via trade"'
          );
        }
        // A separate reason to distrust the number, and one the mod count doesn't hint at: this is
        // a price for the base with these mods at *any* defences, so a 200-armour and a
        // 1000-armour version of the same item are being averaged together.
        if (estimate.defencesDropped) {
          console.warn(
            `[trade2] "${item.name}" had no listings at its own defence totals, so the price ` +
              "ignores them - it compares this base and these mods at any Armour/Evasion/ES"
          );
        }
        return {
          ...base,
          chaosValue: estimate.chaosValue,
          priceSource: "trade2",
          modMatch,
          defencesDropped: estimate.defencesDropped
        };
      }
      tradeReason = estimate.reason;
    }

    console.log(
      `[pricing] "${item.name}" unpriced — ${explainUnpriced(item, this.poeNinja, this.exchange, tradeReason)}`
    );
    return { ...base, chaosValue: null, priceSource: "unpriced" };
  }
}
