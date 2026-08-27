import { app, shell } from "electron";
import { IPC } from "../shared/ipc-channels";
import { useAsciiConsoleOnWindows } from "./console-encoding";
import { loadSettings } from "./settings";
import { registerSetupIpcHandlers, showSetupWindow } from "./setup-window";
import { registerSettingsIpcHandlers, showSettingsWindow } from "./settings-window";
import {
  createOverlayWindow,
  hideOverlay,
  isOverlayFocused,
  onOverlayBlur,
  sendToOverlay,
  setOverlayInteractive,
  showOverlay
} from "./window";
import { registerHotkeys, unregisterAllHotkeys, type HotkeyHandlers } from "./hotkeys";
import { createTray } from "./tray";
import { UpdateChecker, type AvailableUpdate } from "./update-check";
import { ClipboardWatcher } from "./clipboard-watch";
import { ProcessWatcher } from "./process-watch";
import { ForegroundWatcher } from "./foreground-watch";
import { shouldShowOverlay } from "./overlay-visibility";
import { registerIpcHandlers } from "./ipc";
import { parseItemText } from "../parser/item-text-parser";
import { PoeNinjaClient } from "../pricing/poeninja-client";
import { Trade2Client } from "../pricing/trade2-client";
import { CurrencyExchangeClient } from "../pricing/currency-exchange-client";
import { createCancellableGggFetch, createPublicGggFetch } from "../pricing/ggg-fetch";
import { PriceResolver } from "../pricing/price-resolver";
import { PricingQueue } from "../pricing/queue";
import { initStore, addPricedItem } from "../db/store";
import type { OverlayStatus } from "../shared/types";
import type { Settings } from "../shared/settings";

// Before anything can log: the Windows console isn't UTF-8, so em dashes in diagnostic lines
// arrive as "ΓÇö" and make exactly the wrong messages hard to read.
useAsciiConsoleOnWindows();

// Only one instance may run: duplicate copies would each load their own snapshot of the loot
// cache and clobber each other's writes, and only one process can hold the OS-level hotkey
// registrations (the others would silently fail to register theirs).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let overlayInteractive = false;
/**
 * Whether the panel is showing the full list rather than its minimal heads-up form.
 *
 * Held here rather than in the renderer because the `toggleList` hotkey is a global shortcut, so the
 * keypress only ever reaches this process. It rides `OverlayStatus`, which the renderer already
 * reapplies wholesale on every push.
 */
let panelExpanded = false;
/** Set once at startup; `buildStatus()` reads through it so it can be called before construction. */
let statusDeps: { poeNinja: PoeNinjaClient; trade2: Trade2Client; settings: Settings } | null = null;
let processWatcher: ProcessWatcher | null = null;
let updateChecker: UpdateChecker | null = null;
/**
 * A GitHub release newer than this one, or null until the check says otherwise.
 *
 * Held here rather than read back off `updateChecker` for the same reason `statusDeps` is nullable:
 * `buildStatus()` is called before the checker is constructed, on the very first `GET_STATUS`.
 */
let availableUpdate: AvailableUpdate | null = null;
/** False while first-run setup is still deciding what to boot with. See `onSetupSaved`. */
let bootCompleted = false;
/**
 * A key recorder in the settings window is armed, so nothing may be registered — `globalShortcut`
 * takes a combo from the OS before any renderer sees it, and a bound accelerator is therefore
 * invisible to the page trying to record it. Read by `applyHotkeys`; see `SET_HOTKEY_CAPTURE`.
 */
let hotkeyCaptureActive = false;

// Overlay visibility inputs — see overlay-visibility.ts for the rule that combines them.
let foregroundWatcher: ForegroundWatcher | null = null;
let gameRunning = false;
let followFocus = false;
let gameFocused = false;
let trayOverride: "show" | "hide" | null = null;
/** The setup or settings window is open — see `configWindowOpen` on `OverlayVisibilityState`. */
let configWindowOpen = false;
let hideDelayMs = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Latest decision. The deferred hide reads it rather than a snapshot taken when the timer was armed,
 * so a hide armed half a second ago can never take down a window that has since become wanted.
 */
let desiredOverlay = false;

/**
 * Recomputes overlay visibility from every input and applies it. Showing is immediate; hiding waits
 * `overlay.hideDelayMs` so the brief unresolvable foreground PoE2 produces during loading screens
 * and fullscreen mode switches doesn't flash the overlay off and on. Call this after mutating any
 * of the state above.
 */
function applyOverlayVisibility(): void {
  desiredOverlay = shouldShowOverlay({
    gameRunning,
    followFocus,
    gameFocused,
    interactive: overlayInteractive,
    overlayFocused: isOverlayFocused(),
    configWindowOpen,
    trayOverride
  });

  if (desiredOverlay) {
    showOverlay();
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    return;
  }

  if (hideTimer) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (!desiredOverlay) hideOverlay();
  }, hideDelayMs);
}

/**
 * The one place the panel's form is set, and with it whether the overlay takes clicks.
 *
 * Three routes reach it now — the `toggleList` hotkey, a click that landed off the panel
 * (`COLLAPSE_PANEL`), and the overlay losing OS focus — so the coupling between the two flags lives
 * here rather than being restated at each. Expanding and unlocking clicks are one action because the
 * point of opening the list is pressing the Edit buttons in it; see `onToggleList`.
 *
 * The unchanged early return is load-bearing twice: it makes a redundant collapse free, and it stops
 * the `setFocusable(false)` inside `setOverlayInteractive` from re-entering through a second blur.
 */
function setPanelExpanded(expanded: boolean): void {
  if (expanded === panelExpanded) return;
  panelExpanded = expanded;
  overlayInteractive = expanded;
  setOverlayInteractive(overlayInteractive);
  applyOverlayVisibility();
  broadcastStatus();
}

/**
 * Panel state that isn't per-item: conversion rates, how old the prices are, whether the overlay is
 * currently accepting clicks, and how big the panel should be. Pushed on every change so the
 * renderer never infers it.
 */
function buildStatus(): OverlayStatus {
  return {
    rates: statusDeps?.poeNinja.getRates() ?? null,
    pricesFetchedAt: statusDeps?.poeNinja.getLastRefreshAt() ?? null,
    // Converted from a duration to a deadline here, at the one point both are equivalent. See the
    // field's doc comment for why the panel must not be handed the duration.
    tradeCooldownUntil: cooldownDeadline(),
    displayCurrency: statusDeps?.settings.display.currency ?? "auto",
    interactive: overlayInteractive,
    expanded: panelExpanded,
    panel: statusDeps?.settings.overlay.panel ?? { width: 380, maxHeightPercent: 80, position: "right" },
    update: availableUpdate
  };
}

/** `Trade2Client.cooldownMs()` as an absolute time, or null when a search could go out now. */
function cooldownDeadline(): number | null {
  const remaining = statusDeps?.trade2.cooldownMs() ?? 0;
  return remaining > 0 ? Date.now() + remaining : null;
}

function broadcastStatus(): void {
  sendToOverlay(IPC.OVERLAY_STATUS, buildStatus());
}

/**
 * Watches which window has the foreground, so the overlay can get out of the way when you alt-tab.
 *
 * Split out of the boot sequence because the settings window can turn `hideWhenGameUnfocused` on and
 * off, and that has to take effect without a restart — hence stopping whatever is already running
 * first.
 */
function startForegroundWatcher(settings: Settings): void {
  foregroundWatcher?.stop();
  foregroundWatcher = null;

  // Turned off: no helper process, and the overlay stops depending on focus at all. Clearing both
  // inputs matters — a stale `gameFocused: false` left behind would keep hiding the panel forever.
  if (!settings.overlay.hideWhenGameUnfocused) {
    followFocus = false;
    gameFocused = false;
    applyOverlayVisibility();
    return;
  }

  foregroundWatcher = new ForegroundWatcher(settings.poe2ProcessNames, settings.overlay.focusPollIntervalMs);
  foregroundWatcher.on("focused", () => {
    gameFocused = true;
    // Back in the game: normal focus-driven visibility resumes, whichever way the tray was used.
    trayOverride = null;
    applyOverlayVisibility();
  });
  foregroundWatcher.on("unfocused", () => {
    gameFocused = false;
    applyOverlayVisibility();
  });
  // Fail open: without working focus detection the overlay stays permanently visible (the old
  // behaviour) rather than permanently hidden.
  foregroundWatcher.on("unavailable", (message) => {
    console.warn(`[foreground] focus detection unavailable — overlay will stay visible: ${message}`);
    foregroundWatcher?.stop();
    followFocus = false;
    gameFocused = false;
    applyOverlayVisibility();
  });

  // The process watcher starts this on "started", but it has already fired if the game was running
  // when the setting was switched on — so a watcher built now has to catch itself up.
  if (gameRunning) {
    followFocus = true;
    foregroundWatcher.start();
  }
  applyOverlayVisibility();
}

app.whenReady().then(async () => {
  await initStore(app.getPath("userData"));

  // Registered before anything else, and separately from the overlay's handlers: on first run the
  // setup window has to answer before the pricing clients — which registerIpcHandlers needs — can
  // be built with the right league.
  registerSetupIpcHandlers({
    onSetupSaved: () => {
      // During first-run setup the boot below simply continues with the saved values. Afterwards a
      // restart is the honest way to apply them: `settings` is captured in closures here, and the
      // three pricing clients each hold their own reference, so a live league change would take in
      // some places and not others.
      if (!bootCompleted) return;
      console.log("[setup] settings changed — restarting");
      app.relaunch();
      app.quit();
    }
  });

  let settings = loadSettings();
  if (!settings.setupCompleted) {
    console.log("[setup] first run — asking for league and contact email");
    await showSetupWindow();
    // saveSettings replaces the cache, so this is whatever the user just chose (or the untouched
    // defaults if they closed the window without saving).
    settings = loadSettings();
  }

  if (settings.trade2.enabled && !settings.trade2.contactEmail) {
    console.warn(
      "[startup] trade2.contactEmail is not set — GGG requests will carry no contact address. " +
        "Set it from the tray's Setup… if you want them to be able to reach you."
    );
  }

  console.log(
    `[startup] league="${settings.league}", ` +
      `trade2=${
        settings.trade2.enabled
          ? `enabled (${settings.trade2.maxSearchesPerWindow} searches / ${Math.round(
              settings.trade2.windowMs / 60000
            )}min)`
          : "disabled"
      }`
  );

  hideDelayMs = settings.overlay.hideDelayMs;

  createOverlayWindow();
  // Alt-tab, the taskbar, a second display: the panel follows you out of the game otherwise. An
  // expanded panel is interactive, and interactive both pins the sheet on screen (`shouldShowOverlay`)
  // and keeps it swallowing every click across the display — so leaving it open over whatever you
  // switched to is the one state this must not sit in. Only fires while interactive, since that is
  // the only time this window is focusable at all.
  onOverlayBlur(() => {
    // The config windows take the foreground and blur us, and the panel deliberately stays up behind
    // them (`configWindowOpen`) — it is what the width and position fields in there are judged
    // against, so it must not collapse out from under the person setting them.
    if (configWindowOpen) return;
    setPanelExpanded(false);
    // Called even when the line above was a no-op: `overlayFocused` is itself one of the rule's
    // inputs and it has just changed, and nothing else re-evaluates on it. Without this a sheet
    // being held up by that branch alone would stay up after the focus that justified it was gone.
    applyOverlayVisibility();
  });
  const tray = createTray({
    // A tray choice has to survive focus-following, otherwise the overlay would flip back a
    // fraction of a second later; it's cleared once PoE2 next takes focus, and on game exit.
    onShowOverlay: () => {
      trayOverride = "show";
      applyOverlayVisibility();
    },
    onHideOverlay: () => {
      trayOverride = "hide";
      applyOverlayVisibility();
    },
    onOpenSettings: () => {
      // The overlay stays up behind it: the panel's width, position and currency all apply live on
      // Save, and this window is not PoE2 as far as the foreground watcher is concerned — so
      // without this the one thing the user is looking at vanishes half a second after they open it.
      configWindowOpen = true;
      applyOverlayVisibility();
      void showSettingsWindow().then(() => {
        configWindowOpen = false;
        // A window closed while a recorder was armed never sent the matching `false`, so the flag
        // is cleared here rather than trusted — otherwise the hotkeys stay down for good.
        hotkeyCaptureActive = false;
        applyHotkeys();
        applyOverlayVisibility();
      });
    },
    onOpenSetup: () => {
      configWindowOpen = true;
      applyOverlayVisibility();
      void showSetupWindow().then(() => {
        configWindowOpen = false;
        applyOverlayVisibility();
      });
    },
    // The URL is opened here rather than in tray.ts, so this process has exactly one place that
    // hands a link to the browser — see the `onOpenReleases` note on `TrayActions`.
    onOpenReleases: () => {
      if (availableUpdate) void shell.openExternal(availableUpdate.url);
    },
    onQuit: () => app.quit()
  });

  const poeNinja = new PoeNinjaClient(settings);
  const currencyExchange = new CurrencyExchangeClient(settings, createPublicGggFetch(settings));
  // Its own fetch instance, held rather than left inside the client, because Stop has to reach the
  // request it is currently waiting on. Separate from the currency exchange's above for the same
  // reason: cancelling a rare's lookup must not kill a refresh that happens to overlap it.
  const trade2Fetch = createCancellableGggFetch(settings);
  const trade2 = new Trade2Client(settings, trade2Fetch.fetch);

  // Assigned once all three exist, because the status carries the trade2 rate-limit deadline as well
  // as poe.ninja's rates — `buildStatus` reads both and `onRefresh` below can fire immediately.
  statusDeps = { poeNinja, trade2, settings };
  // Rates and price age both change on refresh, and the panel shows both.
  poeNinja.onRefresh(() => broadcastStatus());
  poeNinja.startAutoRefresh();
  currencyExchange.startAutoRefresh();

  const resolver = new PriceResolver(
    poeNinja,
    currencyExchange,
    trade2,
    settings.currencyExchange.stalePoeNinjaAfterMs
  );

  const queue = new PricingQueue(
    resolver,
    async (item) => {
      const stored = await addPricedItem(item);
      sendToOverlay(IPC.PRICED_ITEM, stored);
      // A finished lookup is the only thing that spends a search, so this is the one moment the
      // rate-limit deadline moves. Cheap despite riding a full status push: the send above already
      // triggers a render for this item, and `scheduleRender` coalesces to one rebuild per frame.
      broadcastStatus();
    },
    // Pushed whole on every transition, so the panel can show a captured item straight away rather
    // than staying blank through a trade2 lookup that can run for half a minute.
    (pending) => sendToOverlay(IPC.PRICING_STATUS, pending),
    // What the footer's Stop button reaches, one indirection along: the queue decides an entry was
    // cancelled, this is only how it interrupts the wait. Bound to the trade2 fetch alone, so a
    // currency-exchange refresh running beside it is untouched.
    () => trade2Fetch.cancelInFlight()
  );

  registerIpcHandlers({
    poeNinja,
    trade2,
    settings,
    getStatus: buildStatus,
    queue,
    // The renderer only reports the click; the form it collapses is this process's to hold.
    onCollapsePanel: () => setPanelExpanded(false)
  });

  registerSettingsIpcHandlers({
    onHotkeyCapture: (active) => {
      hotkeyCaptureActive = active;
      applyHotkeys();
    },
    onSettingsSaved: (next) => {
      // Mutated in place, not rebound: `statusDeps`, `registerIpcHandlers` and the clipboard
      // closure all hold *this* object, so assigning a new one would leave every one of them
      // reading the old values. Safe only because nothing downstream captured these three blocks
      // the way the three pricing clients each captured `league` — which is why the league lives in
      // the setup window, where saving relaunches, instead of here.
      settings.hotkeys = next.hotkeys;
      settings.overlay = next.overlay;
      settings.display = next.display;
      // Four fields, not the whole block: `Trade2Client` reads `saleType` and `listingStatus` when
      // it builds a query and the two map keys when it builds a waystone's filters, so these reach
      // the next lookup — but `createPublicGggFetch` and `TradeSearchBudget` captured their trade2
      // values at construction, and reassigning around them would look applied and silently not be.
      settings.trade2.saleType = next.trade2.saleType;
      settings.trade2.listingStatus = next.trade2.listingStatus;
      settings.trade2.useMapFilters = next.trade2.useMapFilters;
      settings.trade2.mapMinRatio = next.trade2.mapMinRatio;

      hideDelayMs = settings.overlay.hideDelayMs;
      startForegroundWatcher(settings);
      // Panel size and display currency both ride OVERLAY_STATUS, and the renderer reapplies them
      // on every one — so this is the whole of applying them.
      broadcastStatus();
      // Re-registered here rather than at window close: the save handler drops every binding around
      // its probe loop, so this is what puts the just-saved accelerators back — and they bind while
      // the window is still open, which is the point. `applyHotkeys` still declines to register
      // anything while a recorder is armed.
      applyHotkeys();
    }
  });

  const clipboardWatcher = new ClipboardWatcher((text) => {
    const item = parseItemText(text);
    if (!item) {
      console.warn("[capture] item-like clipboard text failed to parse");
      return;
    }

    console.log(
      `[capture] captured ${item.rarity} item: ${item.name}${item.stackSize > 1 ? ` x${item.stackSize}` : ""}`
    );
    queue.enqueue(item);
  });

  // Held in a const rather than written inline, because the settings window rebinds these and the
  // re-registration has to attach the same handlers the boot path did.
  const hotkeyHandlers: HotkeyHandlers = {
    // The only thing that ever *opens* the panel — a click or a game event must never do that, and
    // both have been tried and removed. Closing it is no longer exclusive to this key: see
    // `setPanelExpanded`, which the outside-click and blur routes share with it.
    onToggleList: () => setPanelExpanded(!panelExpanded),
    onForceCapture: () => clipboardWatcher.forceCapture()
  };

  /**
   * Drops every binding and reinstates them from the current `settings` — except while the settings
   * window's key recorder is armed, when there must be nothing registered for it to record over.
   *
   * A flag consulted here rather than an unregister/register pair at each call site, so the order
   * the settings window's messages arrive in cannot leave the hotkeys down: whatever happens, the
   * next `applyHotkeys()` lands on the right state.
   */
  const applyHotkeys = (): void => {
    unregisterAllHotkeys();
    if (hotkeyCaptureActive) return;
    registerHotkeys(settings, hotkeyHandlers);
  };

  applyHotkeys();

  startForegroundWatcher(settings);

  // The overlay stays hidden and the clipboard poll stays idle until PoE2 is detected running —
  // no point watching the clipboard (or sitting visible on the desktop) when the game isn't open.
  processWatcher = new ProcessWatcher(settings.poe2ProcessNames);
  processWatcher.on("started", (imageName) => {
    console.log(`[process] PoE2 (${imageName}) detected running — overlay activated`);
    gameRunning = true;
    if (foregroundWatcher) {
      followFocus = true;
      foregroundWatcher.start();
    }
    applyOverlayVisibility();
    clipboardWatcher.start();
  });
  processWatcher.on("stopped", () => {
    console.log("[process] PoE2 no longer running — overlay hidden");
    foregroundWatcher?.stop();
    gameRunning = false;
    followFocus = false;
    gameFocused = false;
    // A "show" from earlier in the session would otherwise keep the panel pinned to the desktop
    // after the game is gone. Tray "Show Overlay" brings it back for reading the list.
    trayOverride = null;
    applyOverlayVisibility();
    clipboardWatcher.stop();
  });
  console.log(`[process] watching for ${settings.poe2ProcessNames.join(", ")}...`);
  processWatcher.start();

  // Last, and deliberately: this is the one thing at boot that talks to a host the app doesn't need
  // in order to work, so it starts once everything that does is already running. It never rejects —
  // see `UpdateChecker.check` — because this chain's `.catch` reports a failed *startup*.
  updateChecker = new UpdateChecker({
    settings,
    currentVersion: app.getVersion(),
    onUpdate: (update) => {
      availableUpdate = update;
      tray.setUpdateAvailable(update);
      // The header line rides OVERLAY_STATUS, which the renderer reapplies wholesale — so this is
      // the whole of getting it on screen.
      broadcastStatus();
    }
  });
  updateChecker.start();

  // Past this point a save from the tray's Settings… has to restart the app rather than hope the
  // new values reach everything constructed above.
  bootCompleted = true;
}).catch((error) => {
  console.error("[startup] failed", error);
});

app.on("window-all-closed", () => {
  // On first run the setup window is the only window there is, and closing it must not quit the
  // app before the overlay has even been created.
  if (!bootCompleted) return;
  unregisterAllHotkeys();
  app.quit();
});

app.on("will-quit", () => {
  unregisterAllHotkeys();
  processWatcher?.stop();
  updateChecker?.stop();
  // Without this the PowerShell helper is orphaned and keeps polling after we're gone.
  foregroundWatcher?.stop();
});
