import { ipcMain, shell } from "electron";
import { IPC } from "../shared/ipc-channels";
import { tradeSearchUrl } from "../shared/trade-link";
import { getSessions, getAllItems, getItem, updateItem, clearHistory } from "../db/store";
import { toChaos } from "../pricing/currency-convert";
import type { PoeNinjaClient } from "../pricing/poeninja-client";
import { toModFilterMap, type Trade2Client } from "../pricing/trade2-client";
import { derivePseudoStats } from "../shared/pseudo-stats";
import { isWaystone, mapRowsOf } from "../shared/map-stats";
import type { ModFilter, OverlayStatus } from "../shared/types";
import type { Settings } from "../shared/settings";

export interface IpcDeps {
  poeNinja: PoeNinjaClient;
  trade2: Trade2Client;
  settings: Settings;
  getStatus: () => OverlayStatus;
  /**
   * Called after the history is wiped, so the main process can drop its in-memory `currentSession`.
   * Without it the next captured item is filed against a session that no longer exists and never
   * counts toward any total.
   */
  onHistoryCleared: () => void;
}

async function sessionFor(sessionId: string) {
  const sessions = await getSessions();
  return sessions.find((s) => s.id === sessionId) ?? null;
}


export function registerIpcHandlers({
  poeNinja,
  trade2,
  settings,
  getStatus,
  onHistoryCleared
}: IpcDeps): void {
  // Pulled once on load; thereafter the main process pushes OVERLAY_STATUS on change.
  ipcMain.handle(IPC.GET_STATUS, () => getStatus());
  ipcMain.handle(IPC.GET_HISTORY, () => getSessions());
  ipcMain.handle(IPC.GET_ALL_ITEMS, () => getAllItems());

  ipcMain.handle(IPC.CLEAR_HISTORY, async () => {
    await clearHistory();
    onHistoryCleared();
    console.log("[history] cleared — previous contents kept in loot-cache.pre-clear.json");
  });

  ipcMain.handle(IPC.GET_EDITOR_ROWS, async (_event, itemId: string) => {
    const item = await getItem(itemId);
    return {
      // Derived on demand rather than stored: both are pure functions of what the item already
      // carries, and persisting them would put a second, staleable copy in `loot-cache.json`.
      pseudoStats: item && !isWaystone(item) ? derivePseudoStats(item) : [],
      pseudoMinRatio: settings.trade2.pseudoMinRatio,
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
              // Inside the conditional on purpose: a reprice that found nothing leaves the displayed
              // price alone, so the link has to keep pointing at the search that produced it. Only a
              // new number gets a new query — and, for the same reason, only a new number gets a new
              // median. The pair on the row must come from one sample or it describes no listing set.
              tradeSearchId: estimate.searchId,
              tradeMedianChaosValue: estimate.medianChaosValue ?? undefined
            }
          : {})
      });

      return {
        item: updated,
        session: updated ? await sessionFor(updated.sessionId) : null,
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
        mapDropped: estimate.mapDropped
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

  ipcMain.handle(IPC.SET_MANUAL_PRICE, async (_event, itemId: string, value: number | null) => {
    const updated = await updateItem(itemId, { manualChaosValue: value });
    return { item: updated, session: updated ? await sessionFor(updated.sessionId) : null };
  });
}
