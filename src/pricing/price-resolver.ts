import type {
  ParsedItem,
  PricedItem,
  TradeFailure,
  UnpricedReason
} from "../shared/types";
import type { PoeNinjaClient } from "./poeninja-client";
import type { CurrencyExchangeClient } from "./currency-exchange-client";
import {
  describeDefences,
  listingsLabelFor,
  type ListingStatus,
  type Trade2Client
} from "./trade2-client";
import { toChaos } from "./currency-convert";
import { formatNumber } from "../shared/format-value";

/**
 * Why an item ended up without a price. "unpriced" covers seven genuinely different situations —
 * one of which is a bug and the rest of which are expected — and collapsing them into a single log
 * line made a broken name->id mapping indistinguishable from working as designed.
 *
 * Returns both halves of the answer from one place: `text` is the sentence, printed to the log and
 * carried to the row's tooltip verbatim; `code` is which situation it was, which picks the badge
 * word. Two returns rather than two functions because they must never disagree — a badge saying one
 * thing while the tooltip under it says another is worse than the single word it replaced.
 */
function explainUnpriced(
  item: ParsedItem,
  poeNinja: PoeNinjaClient,
  exchange: CurrencyExchangeClient,
  tradeReason: string | null,
  tradeFailure: TradeFailure | null
): { code: UnpricedReason; text: string } {
  const { keysTried, entriesLoaded } = poeNinja.describeLookup(item);

  // Ordered most-fundamental first: no data at all explains every miss, so check it before
  // blaming the item.
  if (entriesLoaded === 0 || poeNinja.getLastRefreshAt() === null) {
    return {
      code: "pricesLoading",
      text:
        "poe.ninja data hasn't loaded yet (first refresh still in flight) — this item will stay " +
        "unpriced until it is repriced or given a manual value"
    };
  }

  // poe.ninja only publishes uniques and currency-likes. Rares and magic items are not a lookup
  // failure; there is nothing to look them up in.
  if (item.rarity === "Rare") {
    // trade2 was consulted, so it owns the explanation — budget spent, no listings, HTTP error.
    return {
      // trade2 owns the kind as well as the wording; it is the only thing that looked.
      code: tradeFailure ?? "noListings",
      text: `${tradeReason ?? "trade2 returned nothing"} — or set a manual price with the row's Edit button`
    };
  }
  if (item.rarity === "Magic") {
    // PoE2 glues prefix and suffix onto the base on one header line, so `baseType` for a Magic item
    // is the affixed name (see ParsedItem). There is no real base type to search trade2 with, which
    // is why Magic items don't take the Rare path above.
    return {
      code: "notSearchable",
      text:
        "poe.ninja doesn't list Magic items, and their clipboard header glues the affixes onto the " +
        "base type, leaving nothing reliable to search trade2 with — set a manual price with the " +
        "row's Edit button"
    };
  }

  // The exchange is only ever consulted after poe.ninja misses, so by here it has already been
  // tried; saying which of the two ways it came up short keeps a missing table entry (fixable)
  // distinguishable from an item that simply isn't traded (not fixable).
  const { metadataId, entriesLoaded: exchangeEntries } = exchange.describeLookup(item);
  const exchangeNote =
    metadataId === null
      ? `"${item.name}" has no entry in exchange-metadata-ids.ts`
      : `not traded on the currency exchange (${metadataId}; ${exchangeEntries} priced ids loaded)`;

  // A Normal base is the one rarity that reaches all three sources, so all three have to be
  // accounted for or the line reads as "no data anywhere" when trade search is the only one that
  // could ever have priced it. The exchange note stays ahead of it because a missing metadata id is
  // a fixable bug while "this base has no market" is not, and the two are worth telling apart.
  const tradeNote =
    item.rarity === "Normal" ? ` Trade search: ${tradeReason ?? "returned nothing"}.` : "";

  return {
    // A Normal base reached trade2, so its failure is the specific one; anything else never had a
    // source that could have priced it.
    code: item.rarity === "Normal" ? (tradeFailure ?? "noPriceData") : "noPriceData",
    text:
      `not found in poe.ninja data (tried: ${keysTried.join(", ")}; ${entriesLoaded} entries loaded), ` +
      `and ${exchangeNote}. ` +
      "If that id looks wrong, the name->id mapping needs fixing; if it looks right, the category " +
      "may not be in poeNinja.exchangeOverviewTypes." +
      tradeNote
  };
}

/**
 * Why the strictest threshold didn't produce the price, in the terms the user can act on.
 *
 * The two cases need different words and used to share one sentence. **Zero** means nobody has listed
 * an item with all these mods *under the status filter that was searched* — and which filter that was
 * is the load-bearing part, since the same search on the trade site with the status left at Any shows
 * a different set. A real Sapphire jewel matched 0 on all four of its mods and 16 once offline sellers
 * were counted, which is exactly the gap between what this reports and what the site appears to show.
 * **A handful** means someone has listed one, but a price taken from one or two listings is just
 * that seller's asking price, so the ladder went past it — the trade site is where to look by hand.
 */
function explainStrictMiss(
  rungs: Array<{ required: number; total: number; filters: number }>,
  totalMods: number,
  status: ListingStatus
): string {
  const label = `${listingsLabelFor(status)}`;
  // Both halves matter now that the ladder drops mods as well as lowering the threshold: the rung
  // that asked for everything is the one that sent every filter *and* required all of them.
  const strict = rungs.find((rung) => rung.required === totalMods && rung.filters === totalMods);
  if (!strict || strict.total === 0) {
    // Naming the setting rather than guessing which way to widen: from `securable` the useful step is
    // `available` (add in-person sellers), from `online` it is `any` (add offline ones), and the two
    // are different axes rather than points on one scale.
    const hint = status === "any" ? "" : " (widening trade2.listingStatus would count more)";
    return `has no ${label} carrying all ${totalMods} of its mods${hint}`;
  }
  return (
    `has only ${strict.total} ${label} carrying all ${totalMods} of its mods - too few to take a ` +
    "price from"
  );
}

/** How specific the search that produced a price was, for the log line. See also describeDefences. */
function describeModMatch({ matched, total }: { matched: number; total: number }): string {
  if (total === 0) return "base type only";
  // Every rung requires all of its own filters now, so a shortfall means mods were *dropped* rather
  // than that the threshold was lowered — the survivors were all demanded of every listing.
  return matched >= total ? `all ${total} mods` : `${matched} of ${total} mods, ${total - matched} dropped`;
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
  async resolve(item: ParsedItem, onTradeSearch?: () => void): Promise<Omit<PricedItem, "id">> {
    const base = { ...item, ignoredMods: [], manualChaosValue: null };

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

    // Rares, plus white bases — which are priced on item level alone and so are gated by
    // `trade2.baseItemMinLevel` rather than by anything here. The Trade2Client owns that check
    // along with the enabled/budget ones, so there is exactly one place that decides whether a
    // lookup happens and exactly one place that words the refusal.
    //
    // Magic stays out and always will: PoE2 glues the affixes onto the base on one header line, so
    // `baseType` for a Magic item is the affixed name and there is nothing to search on.
    let tradeReason: string | null = null;
    let tradeFailure: TradeFailure | null = null;
    if (item.rarity === "Rare" || item.rarity === "Normal") {
      console.log(`[pricing] "${item.name}" not in poe.ninja — querying trade2...`);
      onTradeSearch?.();
      const estimate = await this.trade2.estimateRareValue(item, new Set(), (amount, currency) =>
        toChaos(this.poeNinja, amount, currency)
      );
      if (estimate.chaosValue !== null) {
        const modMatch = { matched: estimate.matchedMods, total: estimate.totalMods };
        const defenceNote =
          estimate.defences.length > 0 ? ` and ${describeDefences(estimate.defences)}` : "";
        // What the cheapest seller was actually asking, in their own currency. The chaos figure is
        // this app's conversion of it and the two are easy to mistake for a discrepancy — printing
        // the quote beside it is what lets a number on the panel be matched to a row on the site.
        const quoteNote = estimate.listingQuote
          ? `, cheapest listed at ${formatNumber(estimate.listingQuote.amount)} ${estimate.listingQuote.currency}`
          : "";
        console.log(
          `[pricing] "${item.name}" priced via trade2: ${formatNumber(estimate.chaosValue)} chaos ` +
            `(cheapest of ${estimate.listings} sampled from ${estimate.matches} listings` +
            `${quoteNote}; matching ${describeModMatch(modMatch)}${defenceNote})`
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
        // Everything the estimate carries is persisted here, not a subset of it. This path used to
        // keep six fields and drop `statCoverage`, `coverageSample`, `pseudoDropped` and `mapDropped`
        // on the floor even though the search had already paid for them, so a freshly captured rare
        // showed none of the badges the row is built to render until the user pressed Reprice once —
        // an asymmetry with `REPRICE_ITEM` that looked like missing data rather than a lost write.
        // `autoDroppedMods` is the one that makes it load-bearing: without it the row editor could
        // not show which mods produced an automatic price at all, which is the point of having it.
        return {
          ...base,
          chaosValue: estimate.chaosValue,
          priceSource: "trade2",
          modMatch,
          tradeSearchId: estimate.searchId,
          // Kept in step with the reprice path, like every other field on the estimate: it is
          // what decides the unit the row is displayed in, so dropping it here would leave an
          // automatically priced item reading in exalted until the user pressed Reprice once.
          tradeListingQuote: estimate.listingQuote,
          // The same listing's age, moving with the quote for the same reason: both describe the
          // one listing the headline came from, so they are written and dropped together.
          tradeListingIndexedAt: estimate.listingIndexedAt,
          // And the rest of the window those two came from, for the same reason every other field
          // in this block is here: the search has already paid for it, and a capture that dropped it
          // would offer no sell suggestion until the user pressed Reprice once.
          tradeListingSample: estimate.listingSample,
          defencesDropped: estimate.defencesDropped,
          pseudoDropped: estimate.pseudoDropped,
          mapDropped: estimate.mapDropped,
          statCoverage: estimate.statCoverage,
          coverageSample: estimate.coverageSample,
          autoDroppedMods: estimate.autoDroppedMods,
          // Same reason as the rest of this block: the search has already paid for it, and it is what
          // the row editor ticks from. Dropping it here would leave an automatically priced rare
          // ticking every mod while a repriced one ticked only the searched set.
          searchedMods: estimate.searchedMods
        };
      }
      tradeReason = estimate.reason;
      tradeFailure = estimate.failure;
    }

    const { code, text } = explainUnpriced(
      item,
      this.poeNinja,
      this.exchange,
      tradeReason,
      tradeFailure
    );
    console.log(`[pricing] "${item.name}" unpriced — ${text}`);
    // Both halves are recorded, not just logged: the row has to be able to say *which* of the seven
    // situations this was. "the market has nothing matching this" and "nobody looked yet" ask
    // opposite things of the user — one is final, the other expires on its own — and read as the
    // same word otherwise. `code` picks the badge, `text` is the tooltip under it, and this is the
    // only place either is decided.
    return {
      ...base,
      chaosValue: null,
      priceSource: "unpriced",
      unpricedReason: code,
      unpricedDetail: text
    };
  }
}
