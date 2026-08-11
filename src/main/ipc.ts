import { ipcMain } from "electron";
import { IPC } from "../shared/ipc-channels";
import { getSessions, getAllItems, getItem, updateItem, clearHistory } from "../db/store";
import { toChaos } from "../pricing/currency-convert";
import type { PoeNinjaClient } from "../pricing/poeninja-client";
import type { Trade2Client } from "../pricing/trade2-client";
import type { OverlayStatus } from "../shared/types";

export interface IpcDeps {
  poeNinja: PoeNinjaClient;
  trade2: Trade2Client;
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

export function registerIpcHandlers({ poeNinja, trade2, getStatus, onHistoryCleared }: IpcDeps): void {
  // Pulled once on load; thereafter the main process pushes OVERLAY_STATUS on change.
  ipcMain.handle(IPC.GET_STATUS, () => getStatus());
  ipcMain.handle(IPC.GET_HISTORY, () => getSessions());
  ipcMain.handle(IPC.GET_ALL_ITEMS, () => getAllItems());

  ipcMain.handle(IPC.CLEAR_HISTORY, async () => {
    await clearHistory();
    onHistoryCleared();
    console.log("[history] cleared — previous contents kept in loot-cache.pre-clear.json");
  });

  ipcMain.handle(IPC.REPRICE_ITEM, async (_event, itemId: string, ignoredMods: string[]) => {
    const item = await getItem(itemId);
    if (!item) return null;

    const estimate = await trade2.estimateRareValue(item, new Set(ignoredMods), (amount, currency) =>
      toChaos(poeNinja, amount, currency)
    );

    const updated = await updateItem(itemId, {
      ignoredMods,
      ...(estimate.chaosValue !== null
        ? {
            chaosValue: estimate.chaosValue,
            priceSource: "trade2" as const,
            modMatch: { matched: estimate.matchedMods, total: estimate.totalMods },
            defencesDropped: estimate.defencesDropped
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
      defencesDropped: estimate.defencesDropped
    };
  });

  ipcMain.handle(IPC.SET_MANUAL_PRICE, async (_event, itemId: string, value: number | null) => {
    const updated = await updateItem(itemId, { manualChaosValue: value });
    return { item: updated, session: updated ? await sessionFor(updated.sessionId) : null };
  });
}
