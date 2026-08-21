import { ipcMain, shell } from "electron";
import { IPC } from "../shared/ipc-channels";
import { tradeSearchUrl } from "../shared/trade-link";
import { getAllItems, getItem, updateItem, clearHistory } from "../db/store";
import { toChaos } from "../pricing/currency-convert";
import type { PoeNinjaClient } from "../pricing/poeninja-client";
import { toModFilterMap, type Trade2Client } from "../pricing/trade2-client";
import { derivePseudoStats } from "../shared/pseudo-stats";
import { searchFloorsByMod } from "../shared/mod-rolls";
import { modsOf } from "../shared/mods";
import { isWaystone, mapRowsOf } from "../shared/map-stats";
import type { ModFilter, OverlayStatus } from "../shared/types";
import type { Settings } from "../shared/settings";

export interface IpcDeps {
  poeNinja: PoeNinjaClient;
  trade2: Trade2Client;
  settings: Settings;
  getStatus: () => OverlayStatus;
}

export function registerIpcHandlers({ poeNinja, trade2, settings, getStatus }: IpcDeps): void {
  // Pulled once on load; thereafter the main process pushes OVERLAY_STATUS on change.
  ipcMain.handle(IPC.GET_STATUS, () => getStatus());
  ipcMain.handle(IPC.GET_ALL_ITEMS, () => getAllItems());

  ipcMain.handle(IPC.CLEAR_HISTORY, async () => {
    await clearHistory();
    console.log("[history] cleared — previous contents kept in loot-cache.pre-clear.json");
  });

  ipcMain.handle(IPC.GET_EDITOR_ROWS, async (_event, itemId: string) => {
    const item = await getItem(itemId);
    return {
      // Derived on demand rather than stored: both are pure functions of what the item already
      // carries, and persisting them would put a second, staleable copy in `loot-cache.json`.
      pseudoStats: item && !isWaystone(item) ? derivePseudoStats(item) : [],
      pseudoMinRatio: settings.trade2.pseudoMinRatio,
      // What each mod will actually be searched at, so the prefilled min boxes say the same thing
      // the query does. Shipped rather than recomputed over there for the reason `pseudoMinRatio` is
      // — the renderer is a plain <script>, and a second copy of the rule would disagree the moment
      // one of them was tuned. Without it a Reprice with untouched boxes would send the item's own
      // rolls back as bounds and silently undo the floor.
      modFloors: item ? searchFloorsByMod(modsOf(item)) : [],
      // Empty for anything that isn't a waystone, which is what makes the editor fall back to the
      // ordinary mod rows without needing to know the difference.
      mapRows: item && settings.trade2.useMapFilters ? mapRowsOf(item) : [],
      mapMinRatio: settings.trade2.mapMinRatio
    };
  });

  ipcMain.handle(
    IPC.REPRICE_ITEM,
    async (
      _event,
      itemId: string,
      ignoredMods: string[],
      modFilters: ModFilter[] = [],
      pseudoFilters: ModFilter[] = [],
      mapFilters: ModFilter[] = []
    ) => {
      const item = await getItem(itemId);
      if (!item) return null;

      const estimate = await trade2.estimateRareValue(
        item,
        new Set(ignoredMods),
        (amount, currency) => toChaos(poeNinja, amount, currency),
        toModFilterMap(modFilters),
        toModFilterMap(pseudoFilters),
        toModFilterMap(mapFilters)
      );

      // Both the exclusions and the bounds persist even when the search came back empty: this is the
      // request the user tuned, and a spent rate-limit budget must not silently discard it before
      // they can press Reprice again.
      const updated = await updateItem(itemId, {
        ignoredMods,
        modFilters,
        pseudoFilters,
        mapFilters,
        // Written on every reprice, outside the conditional below, because they have to be *cleared*
        // as well as set: an item that was rate-limited an hour ago and has just priced would
        // otherwise keep the badge for good, and one that failed for a new reason would keep the old
        // one. The pair moves together — a stale detail under a fresh badge word describes neither.
        unpricedReason: estimate.failure ?? undefined,
        unpricedDetail: estimate.failure ? (estimate.reason ?? undefined) : undefined,
        ...(estimate.chaosValue !== null
          ? {
              chaosValue: estimate.chaosValue,
              priceSource: "trade2" as const,
              modMatch: { matched: estimate.matchedMods, total: estimate.totalMods },
              defencesDropped: estimate.defencesDropped,
              pseudoDropped: estimate.pseudoDropped,
              mapDropped: estimate.mapDropped,
              statCoverage: estimate.statCoverage,
              coverageSample: estimate.coverageSample,
              // Overwritten wholesale, never merged. The user just repriced with a given set of boxes
              // ticked, so anything they left unticked is in `ignoredMods` above and is now their
              // decision rather than the ladder's; carrying the old automatic set forward as well
              // would let the two accumulate until the search had nothing left to send.
              autoDroppedMods: estimate.autoDroppedMods,
              // Overwritten wholesale for the same reason, and it has to move in step with the two
              // lists above: it is what the editor ticks from, so a stale copy would credit this
              // price to the mods the *previous* search asked for.
              searchedMods: estimate.searchedMods,
              // Inside the conditional on purpose: a reprice that found nothing leaves the displayed
              // price alone, so the link has to keep pointing at the search that produced it. Only a
              // new number gets a new query.
              tradeSearchId: estimate.searchId,
              // Same conditional and the same reason: a new price gets a new quote, since the
              // unit shown has to describe the listing the number came from — and the same goes for
              // that listing's age. All three describe one listing and move together, or the row
              // annotates this price with some other seller's details.
              tradeListingQuote: estimate.listingQuote,
              tradeListingIndexedAt: estimate.listingIndexedAt
            }
          : {})
      });

      return {
        item: updated,
        // Passed straight through to the panel: a spent rate-limit budget and "nothing matches these
        // mods" need different actions from the user, and "No matching listings" covered both.
        reason: estimate.reason,
        listings: estimate.listings,
        matches: estimate.matches,
        matchedMods: estimate.matchedMods,
        totalMods: estimate.totalMods,
        // So the status line can say the price ignores this item's own armour, which the mod counts
        // above give no hint of.
        defencesDropped: estimate.defencesDropped,
        // Same again for the aggregates, plus the aggregates themselves: three resistance rolls
        // searched as one total is why five mods produced two filters, and the counts alone would
        // leave that looking like mods had gone missing.
        pseudoDropped: estimate.pseudoDropped,
        pseudoStats: estimate.pseudoStats,
        mapDropped: estimate.mapDropped,
        // The panel words its own status line from this: pressing Reprice into a spent budget should
        // read as "not looked up yet", not as "no listings match". Derived rather than carried, so
        // the renderer's one warning style stays keyed on the one kind that resolves by waiting.
        rateLimited: estimate.failure === "rateLimited"
      };
    }
  );

  ipcMain.handle(IPC.OPEN_TRADE_SEARCH, async (_event, itemId: string) => {
    const item = await getItem(itemId);
    // `settings` is the live object `onSettingsSaved` mutates rather than a league captured at
    // construction, so a league changed since boot is the one the link carries.
    const url = tradeSearchUrl(settings.league, item?.tradeSearchId);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
  });

  // Read off `getStatus()` rather than through a dep of its own: `OverlayStatus.update` is already
  // the value the header rendered the line from, so there is no second source that could disagree
  // with what the user clicked. False when nothing is being advertised, like the handler above.
  ipcMain.handle(IPC.OPEN_RELEASES_PAGE, async () => {
    const update = getStatus().update;
    if (!update) return false;
    await shell.openExternal(update.url);
    return true;
  });

  ipcMain.handle(IPC.REFRESH_PRICES, async () => {
    // Success is `getLastRefreshAt()` having moved, rather than a new return type on `refresh()`.
    // That field is advanced only when a category actually answered, which is precisely the question
    // the button needs answered — so the two share one rule instead of growing a second one that
    // could disagree. A refresh where every request failed leaves it alone, and the button says so.
    const before = poeNinja.getLastRefreshAt();
    await poeNinja.refresh();
    const refreshedAt = poeNinja.getLastRefreshAt();
    return { refreshedAt, updated: refreshedAt !== before };
  });

  ipcMain.handle(IPC.SET_MANUAL_PRICE, async (_event, itemId: string, value: number | null) => {
    const updated = await updateItem(itemId, { manualChaosValue: value });
    return { item: updated };
  });
}
