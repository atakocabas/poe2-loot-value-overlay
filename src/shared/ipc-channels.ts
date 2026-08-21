export const IPC = {
  PRICED_ITEM: "priced-item",
  /**
   * Captures that don't have a price yet, pushed whole on every transition.
   *
   * Its own channel rather than a field on `OVERLAY_STATUS`, because `applyStatus` rebuilds the
   * entire item list on every status push — and this fires on every capture. There is deliberately
   * no matching `GET_` pull: that exists on `OVERLAY_STATUS` for the load race, and there isn't one
   * here, since the overlay window is created once at boot and nothing is pending at boot.
   */
  PRICING_STATUS: "pricing-status",
  /** Everything the panel needs to render but that isn't per-item: rates, freshness, input mode. */
  OVERLAY_STATUS: "overlay-status",
  GET_STATUS: "get-status",
  /** Every recorded item, for the panel's one list. */
  GET_ALL_ITEMS: "get-all-items",
  CLEAR_HISTORY: "clear-history",
  /**
   * The rows the editor shows that aren't mod lines — derived pseudo aggregates and a waystone's
   * reward totals — plus the ratios their floors are computed from.
   *
   * A pull rather than fields on the item because the derivation is a table of anchored regexes, and
   * the renderer is a plain <script> that can't import shared modules at runtime; sending the result
   * keeps that classifier in one place instead of duplicating it into common.ts. The ratios ride
   * along for the same reason — a copy of `pseudoMinRatio` over there would quietly disagree with the
   * search the moment anyone tuned the setting.
   */
  GET_EDITOR_ROWS: "get-editor-rows",
  REPRICE_ITEM: "reprice-item",
  /**
   * Opens the trade2 search a price came from in the system browser.
   *
   * Takes an item id rather than a URL, for the same reason `GET_EDITOR_ROWS` takes one: the renderer
   * is a plain <script> and can't import `tradeSearchUrl`, and pushing `league` at it just to build
   * the string over there would put a second copy of that derivation in `common.ts`. It also means
   * `shell.openExternal` is only ever reached with a URL this app assembled from its own hardcoded
   * origin — the renderer never handles one at all.
   */
  OPEN_TRADE_SEARCH: "open-trade-search",
  /**
   * Opens the GitHub release page for the update the header is advertising, in the system browser.
   *
   * Takes no argument at all, for the reason above one line for one: the URL came from GitHub's API
   * rather than from anything this app assembled, so handing it to the renderer and taking it back
   * would be the one place `shell.openExternal` is reached with a string that made a round trip
   * through a page. Main already holds the `AvailableUpdate` behind `OverlayStatus.update`; the
   * renderer only has to say "that one".
   */
  OPEN_RELEASES_PAGE: "open-releases-page",
  SET_MANUAL_PRICE: "set-manual-price",
  /**
   * Pulls poe.ninja now instead of waiting out the 10-minute timer, for the panel's Refresh button.
   *
   * Answers whether prices actually came back, which is not the same as "the request finished" — a
   * refresh that fetched nothing leaves the cache exactly as stale as it was. It needs no companion
   * push: `PoeNinjaClient.onRefresh` already broadcasts `OVERLAY_STATUS`, which is what carries the
   * new age and rates to the header.
   */
  REFRESH_PRICES: "refresh-prices",

  // The setup window's two channels. Registered separately from the overlay's, because on first
  // run setup runs to completion *before* the pricing clients and watchers those handlers need
  // exist — see `registerSetupIpcHandlers`.
  /** Current values, for the form's initial state. */
  GET_SETUP_CONFIG: "get-setup-config",
  SAVE_SETUP_CONFIG: "save-setup-config",

  // The settings window's two channels — the half of the configuration that applies without a
  // restart. Registered alongside the overlay's rather than with setup's, since unlike setup they
  // gate nothing during boot.
  /** Current hotkeys/overlay/display values, plus the shipped defaults behind the Reset buttons. */
  GET_SETTINGS_CONFIG: "get-settings-config",
  /** Validates, probes the accelerators, writes, and applies live. Returns what didn't take. */
  SAVE_SETTINGS_CONFIG: "save-settings-config"
} as const;
