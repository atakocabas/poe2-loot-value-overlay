import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";
import type {
  MapRow,
  ModFilter,
  OverlayStatus,
  PendingCapture,
  PricedItem,
  PseudoStat,
  SettingsConfig,
  SettingsSaveResult,
  SettingsState,
  SetupConfig,
  SetupState
} from "../shared/types";

export interface RepriceResult {
  item: PricedItem | null;
  /** Why no price came back, already worded for display. null when the reprice succeeded. */
  reason: string | null;
  /** Listings the median was taken over — the sample, not every listing that matched. */
  listings: number;
  /** Listings the search matched in total, which the sample was drawn from the middle of. */
  matches: number;
  /** Mods every priced listing carried, and how many the item offered. See `searchRungs()`. */
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
  /** No search went out — the rate-limit budget declined it. Distinct from "nothing matched". */
  rateLimited: boolean;
}

/** The editor's non-mod rows, plus the ratios their floors are derived from. */
export interface EditorRowsResult {
  pseudoStats: PseudoStat[];
  /** `trade2.pseudoMinRatio`, so the editor shows the floor the search will actually use. */
  pseudoMinRatio: number;
  /**
   * The roll each mod is searched at, keyed by its display text — `searchFloor()` applied to the
   * item's own mods. The editor prefills its min boxes from this rather than from the printed roll,
   * so the boxes report the query rather than the item.
   */
  modFloors: Array<{ text: string; min: number }>;
  /** A waystone's reward totals; empty for everything else. */
  mapRows: MapRow[];
  mapMinRatio: number;
}

export interface SetManualPriceResult {
  item: PricedItem | null;
}

export interface RefreshPricesResult {
  /** Epoch ms of the prices now in use — unchanged from before when nothing came back. */
  refreshedAt: number | null;
  /**
   * Whether this pull actually replaced anything. False means every category failed, which leaves
   * the cache exactly as stale as it was — a distinction the button has to make, since "the request
   * finished" and "there are new prices" look identical from the renderer otherwise.
   */
  updated: boolean;
}

contextBridge.exposeInMainWorld("poe2Overlay", {
  onPricedItem: (callback: (item: PricedItem) => void) => {
    ipcRenderer.on(IPC.PRICED_ITEM, (_event, item: PricedItem) => callback(item));
  },
  onOverlayStatus: (callback: (status: OverlayStatus) => void) => {
    ipcRenderer.on(IPC.OVERLAY_STATUS, (_event, status: OverlayStatus) => callback(status));
  },
  onPricingStatus: (callback: (pending: PendingCapture[]) => void) => {
    ipcRenderer.on(IPC.PRICING_STATUS, (_event, pending: PendingCapture[]) => callback(pending));
  },
  getStatus: (): Promise<OverlayStatus> => ipcRenderer.invoke(IPC.GET_STATUS),
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
  /**
   * Opens the release page for the update the header is advertising. Takes nothing — main holds the
   * URL, and the renderer never handles one. False when there is no update to open.
   */
  openReleasesPage: (): Promise<boolean> => ipcRenderer.invoke(IPC.OPEN_RELEASES_PAGE),
  setManualPrice: (itemId: string, value: number | null): Promise<SetManualPriceResult> =>
    ipcRenderer.invoke(IPC.SET_MANUAL_PRICE, itemId, value),
  /** Pulls poe.ninja now. Resolves when the pull finishes — the header updates itself off the push. */
  refreshPrices: (): Promise<RefreshPricesResult> => ipcRenderer.invoke(IPC.REFRESH_PRICES)
});

// The setup window loads this same preload — a second one would duplicate the wiring to expose
// two calls the overlay simply never reaches for.
contextBridge.exposeInMainWorld("poe2Setup", {
  getConfig: (): Promise<SetupState> => ipcRenderer.invoke(IPC.GET_SETUP_CONFIG),
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
