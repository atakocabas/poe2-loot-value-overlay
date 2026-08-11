export const IPC = {
  PRICED_ITEM: "priced-item",
  SESSION_UPDATE: "session-update",
  ZONE_STATUS: "zone-status",
  /** Everything the panel needs to render but that isn't per-item: rates, freshness, input mode. */
  OVERLAY_STATUS: "overlay-status",
  GET_STATUS: "get-status",
  /** Sessions, newest first. Only the first is used now — the header's "in map" line and total. */
  GET_HISTORY: "get-history",
  /** Every recorded item, for the panel's one list. */
  GET_ALL_ITEMS: "get-all-items",
  CLEAR_HISTORY: "clear-history",
  REPRICE_ITEM: "reprice-item",
  SET_MANUAL_PRICE: "set-manual-price",

  // The setup window's three channels. Registered separately from the overlay's, because on first
  // run setup runs to completion *before* the pricing clients and watchers those handlers need
  // exist — see `registerSetupIpcHandlers`.
  /** Current values plus what Steam detection found, for the form's initial state. */
  GET_SETUP_CONFIG: "get-setup-config",
  /** Opens the native file picker for Client.txt. Returns the chosen path, or null if cancelled. */
  BROWSE_CLIENT_TXT: "browse-client-txt",
  SAVE_SETUP_CONFIG: "save-setup-config"
} as const;
