import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { OverlayStatus, PricedItem, Session, SetupConfig, SetupState, ZoneStatus } from "../shared/types";

export interface RepriceResult {
  item: PricedItem | null;
  session: Session | null;
  /** Why no price came back, already worded for display. null when the reprice succeeded. */
  reason: string | null;
  /** Listings the median was taken over — the sample, not every listing that matched. */
  listings: number;
  /** Listings the search matched in total, which the sample was drawn from the middle of. */
  matches: number;
  /** Mods the priced listings all shared, and how many the item offered. See `modLadder()`. */
  matchedMods: number;
  totalMods: number;
  /** Nothing matched at this item's own defence totals, so the search dropped that constraint. */
  defencesDropped: boolean;
}

export interface SetManualPriceResult {
  item: PricedItem | null;
  session: Session | null;
}

contextBridge.exposeInMainWorld("poe2Overlay", {
  onPricedItem: (callback: (item: PricedItem) => void) => {
    ipcRenderer.on(IPC.PRICED_ITEM, (_event, item: PricedItem) => callback(item));
  },
  onSessionUpdate: (callback: (session: Session) => void) => {
    ipcRenderer.on(IPC.SESSION_UPDATE, (_event, session: Session) => callback(session));
  },
  onZoneStatus: (callback: (status: ZoneStatus) => void) => {
    ipcRenderer.on(IPC.ZONE_STATUS, (_event, status: ZoneStatus) => callback(status));
  },
  onOverlayStatus: (callback: (status: OverlayStatus) => void) => {
    ipcRenderer.on(IPC.OVERLAY_STATUS, (_event, status: OverlayStatus) => callback(status));
  },
  getStatus: (): Promise<OverlayStatus> => ipcRenderer.invoke(IPC.GET_STATUS),
  getHistory: (): Promise<Session[]> => ipcRenderer.invoke(IPC.GET_HISTORY),
  getAllItems: (): Promise<PricedItem[]> => ipcRenderer.invoke(IPC.GET_ALL_ITEMS),
  clearHistory: (): Promise<void> => ipcRenderer.invoke(IPC.CLEAR_HISTORY),
  repriceItem: (itemId: string, ignoredMods: string[]): Promise<RepriceResult> =>
    ipcRenderer.invoke(IPC.REPRICE_ITEM, itemId, ignoredMods),
  setManualPrice: (itemId: string, value: number | null): Promise<SetManualPriceResult> =>
    ipcRenderer.invoke(IPC.SET_MANUAL_PRICE, itemId, value)
});

// The setup window loads this same preload — a second one would duplicate the wiring to expose
// three calls the overlay simply never reaches for.
contextBridge.exposeInMainWorld("poe2Setup", {
  getConfig: (): Promise<SetupState> => ipcRenderer.invoke(IPC.GET_SETUP_CONFIG),
  browseClientTxt: (): Promise<string | null> => ipcRenderer.invoke(IPC.BROWSE_CLIENT_TXT),
  save: (config: SetupConfig): Promise<void> => ipcRenderer.invoke(IPC.SAVE_SETUP_CONFIG, config)
});
