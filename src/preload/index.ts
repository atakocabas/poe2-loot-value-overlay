import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";
import type {
  MapRow,
  ModFilter,
  OverlayStatus,
  PendingCapture,
  PricedItem,
  PseudoStat,
  Session,
  SettingsConfig,
  SettingsSaveResult,
  SettingsState,
  SetupConfig,
  SetupState,
  ZoneStatus
} from "../shared/types";

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
  /** Nothing matched at this item's own aggregate totals, so the search dropped those too. */
  pseudoDropped: boolean;
  /** The aggregates the price came from, so the status line can explain the smaller filter count. */
  pseudoStats: PseudoStat[];
  /** A waystone's reward floors matched nothing, so the price is off the base type alone. */
  mapDropped: boolean;
}

/** The editor's non-mod rows, plus the ratios their floors are derived from. */
export interface EditorRowsResult {
  pseudoStats: PseudoStat[];
  /** `trade2.pseudoMinRatio`, so the editor shows the floor the search will actually use. */
  pseudoMinRatio: number;
  /** A waystone's reward totals; empty for everything else. */
  mapRows: MapRow[];
  mapMinRatio: number;
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
  onPricingStatus: (callback: (pending: PendingCapture[]) => void) => {
    ipcRenderer.on(IPC.PRICING_STATUS, (_event, pending: PendingCapture[]) => callback(pending));
  },
  getStatus: (): Promise<OverlayStatus> => ipcRenderer.invoke(IPC.GET_STATUS),
  getHistory: (): Promise<Session[]> => ipcRenderer.invoke(IPC.GET_HISTORY),
  getAllItems: (): Promise<PricedItem[]> => ipcRenderer.invoke(IPC.GET_ALL_ITEMS),
  clearHistory: (): Promise<void> => ipcRenderer.invoke(IPC.CLEAR_HISTORY),
  getEditorRows: (itemId: string): Promise<EditorRowsResult> =>
    ipcRenderer.invoke(IPC.GET_EDITOR_ROWS, itemId),
  repriceItem: (
    itemId: string,
    ignoredMods: string[],
    modFilters: ModFilter[],
    pseudoFilters: ModFilter[],
    mapFilters: ModFilter[]
  ): Promise<RepriceResult> =>
    ipcRenderer.invoke(IPC.REPRICE_ITEM, itemId, ignoredMods, modFilters, pseudoFilters, mapFilters),
  /** False when the item has no search to open — priced off poe.ninja, or captured before the id was. */
  openTradeSearch: (itemId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.OPEN_TRADE_SEARCH, itemId),
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

// And so does the settings window, for the same reason. Kept a separate bridge rather than folded
// into `poe2Setup`, because the two windows apply their values in opposite ways — this one live, that
// one by relaunching — and one object offering both would invite calling them together.
contextBridge.exposeInMainWorld("poe2Settings", {
  getConfig: (): Promise<SettingsState> => ipcRenderer.invoke(IPC.GET_SETTINGS_CONFIG),
  save: (config: SettingsConfig): Promise<SettingsSaveResult> =>
    ipcRenderer.invoke(IPC.SAVE_SETTINGS_CONFIG, config)
});
