import { app } from "electron";
import fs from "node:fs";
import { IPC } from "../shared/ipc-channels";
import { useAsciiConsoleOnWindows } from "./console-encoding";
import { loadSettings, saveSettings } from "./settings";
import { detectClientTxtPath } from "./poe2-install";
import { registerSetupIpcHandlers, showSetupWindow } from "./setup-window";
import { registerSettingsIpcHandlers, showSettingsWindow } from "./settings-window";
import {
  createOverlayWindow,
  hideOverlay,
  isOverlayFocused,
  sendToOverlay,
  setOverlayInteractive,
  showOverlay
} from "./window";
import { registerHotkeys, unregisterAllHotkeys, type HotkeyHandlers } from "./hotkeys";
import { createTray } from "./tray";
import { ClipboardWatcher } from "./clipboard-watch";
import { ClientLogWatcher } from "./logwatch";
import { ProcessWatcher } from "./process-watch";
import { ForegroundWatcher } from "./foreground-watch";
import { shouldShowOverlay } from "./overlay-visibility";
import { isSessionActive } from "../shared/session";
import { registerIpcHandlers } from "./ipc";
import { parseItemText } from "../parser/item-text-parser";
import { PoeNinjaClient } from "../pricing/poeninja-client";
import { Trade2Client } from "../pricing/trade2-client";
import { CurrencyExchangeClient } from "../pricing/currency-exchange-client";
import { createPublicGggFetch } from "../pricing/ggg-fetch";
import { PriceResolver } from "../pricing/price-resolver";
import { PricingQueue } from "../pricing/queue";
import { initStore, startSession, endSession, getActiveSession, addPricedItem } from "../db/store";
import type { OverlayStatus, Session } from "../shared/types";
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

let currentSession: Session | null = null;
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
let statusDeps: { poeNinja: PoeNinjaClient; settings: Settings } | null = null;
let processWatcher: ProcessWatcher | null = null;
let logWatcher: ClientLogWatcher | null = null;
/** False while first-run setup is still deciding what to boot with. See `onSetupSaved`. */
let bootCompleted = false;

// Overlay visibility inputs — see overlay-visibility.ts for the rule that combines them.
let foregroundWatcher: ForegroundWatcher | null = null;
let gameRunning = false;
let followFocus = false;
let gameFocused = false;
let trayOverride: "show" | "hide" | null = null;
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

async function broadcastSession(session: Session): Promise<void> {
  currentSession = session;
  sendToOverlay(IPC.SESSION_UPDATE, session);
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
    displayCurrency: statusDeps?.settings.display.currency ?? "auto",
    interactive: overlayInteractive,
    expanded: panelExpanded,
    panel: statusDeps?.settings.overlay.panel ?? { width: 380, maxHeightPercent: 80, position: "right" }
  };
}

function broadcastStatus(): void {
  sendToOverlay(IPC.OVERLAY_STATUS, buildStatus());
}

/** Closes the in-progress session, if there is one. No-op when nothing is running. */
async function endCurrentSession(): Promise<void> {
  if (!isSessionActive(currentSession)) return;
  console.log(`[map] ending session ${currentSession.id}`);
  await endSession(currentSession.id);
  await broadcastSession({ ...currentSession, endedAt: Date.now() });
}

/**
 * Settles which Client.txt to tail, persisting the answer so this only costs a registry read once.
 *
 * Detection runs both when nothing is configured *and* when the configured file has gone missing —
 * that second case is a player moving PoE2 to another drive, which would otherwise silently kill
 * map detection with a path that looks perfectly fine in settings.json.
 */
async function resolveClientTxtPath(settings: Settings): Promise<Settings> {
  if (settings.clientTxtPath && fs.existsSync(settings.clientTxtPath)) return settings;

  const detected = await detectClientTxtPath();
  if (!detected) return settings;

  console.log(
    settings.clientTxtPath
      ? `[startup] configured Client.txt is missing — found the Steam install at ${detected}`
      : `[startup] auto-detected Client.txt at ${detected}`
  );

  const updated = { ...settings, clientTxtPath: detected };
  saveSettings(updated);
  return updated;
}

/**
 * Tails Client.txt for zone transitions, starting and ending map sessions off them. Split out of
 * the boot sequence so a path chosen in the setup window can take effect without a restart —
 * hence stopping whatever is already running first.
 */
function startLogWatcher(settings: Settings): void {
  logWatcher?.stop();

  if (!settings.clientTxtPath) {
    console.warn("[startup] clientTxtPath is not set — automatic map detection is disabled");
    logWatcher = null;
    return;
  }

  // Scoped to this watcher, so rebinding to a new file starts from a clean slate — correct, since
  // the new watcher backfills and re-announces the current zone.
  let lastZoneName: string | null = null;
  logWatcher = new ClientLogWatcher(settings.clientTxtPath, settings.logWatch);
  logWatcher.on("zone-change", async ({ zoneName, isHideoutOrTown, isHideout }) => {
    // PoE2 re-logs the same zone on instance reloads and after loading screens; without this a
    // second identical event would close the running session and open a duplicate.
    if (zoneName === lastZoneName) return;
    lastZoneName = zoneName;

    console.log(`[map] zone changed: "${zoneName}"${isHideoutOrTown ? " (hideout/atlas)" : ""}`);
    // Also ends the previous session on a map -> map transition. Starting one without closing
    // the last left rows stranded with endedAt === null, which the header shows as forever "in
    // progress" and getActiveSession() then resolves past.
    await endCurrentSession();
    if (!isHideoutOrTown) {
      console.log(`[map] starting new session for zone "${zoneName}"`);
      const session = await startSession(settings.league, zoneName);
      await broadcastSession(session);
    }
    sendToOverlay(IPC.ZONE_STATUS, { zoneName, isHideout });
  });
  logWatcher.on("error", (error) => console.warn("[logwatch]", error.message));

  // Deliberately NOT gated behind ProcessWatcher. Tailing a file costs nothing while the game is
  // closed, and routing the start through process detection means one stale executable name
  // silently disables map detection entirely — which is exactly what happened. Process detection
  // now governs overlay visibility and the clipboard watcher only.
  logWatcher.start();
}

/**
 * Watches which window has the foreground, so the overlay can get out of the way when you alt-tab.
 *
 * Split out of the boot sequence for the same reason as `startLogWatcher` — the settings window can
 * turn `hideWhenGameUnfocused` on and off, and that has to take effect without a restart — hence
 * stopping whatever is already running first.
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

/**
 * The session to file a capture against, opening one if nothing is running.
 *
 * `manual` marks the session as a map the user declared, which is true of the toggle-session hotkey
 * and false of everything else. A capture in a hideout still opens a session — the item has to be
 * filed somewhere and its value has to count — but that session is deliberately *not* a map, or the
 * overlay would drop into its in-map form the moment you pressed Ctrl+C outside one. See
 * `isMapSession`.
 */
async function ensureActiveSession(league: string, manual = false): Promise<Session> {
  if (isSessionActive(currentSession)) return currentSession;
  const active = await getActiveSession();
  if (active) {
    currentSession = active;
    return active;
  }
  const session = await startSession(league, null, manual);
  await broadcastSession(session);
  return session;
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
    console.log("[setup] first run — asking for league, Client.txt and contact email");
    await showSetupWindow();
    // saveSettings replaces the cache, so this is whatever the user just chose (or the untouched
    // defaults if they closed the window without saving).
    settings = loadSettings();
  }
  settings = await resolveClientTxtPath(settings);

  if (settings.trade2.enabled && !settings.trade2.contactEmail) {
    console.warn(
      "[startup] trade2.contactEmail is not set — GGG requests will carry no contact address. " +
        "Set it from the tray's Setup… if you want them to be able to reach you."
    );
  }

  console.log(
    `[startup] league="${settings.league}", clientTxtPath=${settings.clientTxtPath || "(not set)"}, ` +
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
  createTray({
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
      // Suspended for as long as the window is up. A registered accelerator is taken by the OS
      // before it reaches any renderer, so the key recorder could never capture a combo that is
      // currently bound — the same mechanism that rules out Ctrl+C as a capture hotkey. It also
      // makes `probeAccelerator` honest, which would otherwise report our own bindings as taken.
      unregisterAllHotkeys();
      void showSettingsWindow().then(() => applyHotkeys());
    },
    onOpenSetup: () => void showSetupWindow(),
    onQuit: () => app.quit()
  });

  const poeNinja = new PoeNinjaClient(settings);
  statusDeps = { poeNinja, settings };
  // Rates and price age both change on refresh, and the panel shows both.
  poeNinja.onRefresh(() => broadcastStatus());
  poeNinja.startAutoRefresh();

  const currencyExchange = new CurrencyExchangeClient(settings, createPublicGggFetch(settings));
  currencyExchange.startAutoRefresh();

  const trade2 = new Trade2Client(settings);
  const resolver = new PriceResolver(
    poeNinja,
    currencyExchange,
    trade2,
    settings.currencyExchange.stalePoeNinjaAfterMs
  );

  registerIpcHandlers({
    poeNinja,
    trade2,
    settings,
    getStatus: buildStatus,
    // The cleared session is gone from the store; keeping it here would file the next captured
    // item against a dangling sessionId. Nulling it makes ensureActiveSession() open a fresh one.
    onHistoryCleared: () => {
      currentSession = null;
    }
  });

  registerSettingsIpcHandlers({
    onSettingsSaved: (next) => {
      // Mutated in place, not rebound: `statusDeps`, `registerIpcHandlers` and the clipboard
      // closure all hold *this* object, so assigning a new one would leave every one of them
      // reading the old values. Safe only because nothing downstream captured these three blocks
      // the way the three pricing clients each captured `league` — which is why the league lives in
      // the setup window, where saving relaunches, instead of here.
      settings.hotkeys = next.hotkeys;
      settings.overlay = next.overlay;
      settings.display = next.display;

      hideDelayMs = settings.overlay.hideDelayMs;
      startForegroundWatcher(settings);
      // Panel size and display currency both ride OVERLAY_STATUS, and the renderer reapplies them
      // on every one — so this is the whole of applying them.
      broadcastStatus();
      // The hotkeys are deliberately *not* re-registered here: they stay suspended until the
      // settings window closes. See `onOpenSettings` above.
    }
  });

  const queue = new PricingQueue(
    resolver,
    () => currentSession?.id ?? "",
    async (item) => {
      const stored = await addPricedItem(item);
      sendToOverlay(IPC.PRICED_ITEM, stored);

      const session = (await getActiveSession()) ?? currentSession;
      if (session) await broadcastSession(session);
    },
    // Pushed whole on every transition, so the panel can show a captured item straight away rather
    // than staying blank through a trade2 lookup that can run for half a minute.
    (pending) => sendToOverlay(IPC.PRICING_STATUS, pending)
  );

  const clipboardWatcher = new ClipboardWatcher((text) => {
    const item = parseItemText(text);
    if (!item) {
      console.warn("[capture] item-like clipboard text failed to parse");
      return;
    }

    console.log(
      `[capture] captured ${item.rarity} item: ${item.name}${item.stackSize > 1 ? ` x${item.stackSize}` : ""}`
    );
    void ensureActiveSession(settings.league).then(() => queue.enqueue(item));
  });

  // Held in a const rather than written inline, because the settings window rebinds these and the
  // re-registration has to attach the same handlers the boot path did.
  const hotkeyHandlers: HotkeyHandlers = {
    onToggleOverlay: () => {
      overlayInteractive = !overlayInteractive;
      setOverlayInteractive(overlayInteractive);
      applyOverlayVisibility();
      // Click-through and interactive looked identical, so the buttons silently stopped working.
      broadcastStatus();
    },
    // The only thing that ever changes the panel's form. Nothing else collapses or expands it —
    // entering a map used to, and that was removed: the panel's size is the user's business.
    onToggleList: () => {
      panelExpanded = !panelExpanded;
      // Opening unlocks clicks and closing locks them again, because the point of this key is to
      // reach the rows' Edit buttons — with the two separate that is two keypresses every time.
      // `toggleOverlay` still switches click-through on its own without changing the panel's size.
      overlayInteractive = panelExpanded;
      setOverlayInteractive(overlayInteractive);
      applyOverlayVisibility();
      broadcastStatus();
    },
    onToggleSession: async () => {
      if (isSessionActive(currentSession)) {
        console.log("[map] manual hotkey: ending session");
        await endCurrentSession();
      } else {
        console.log("[map] manual hotkey: starting new session");
        // Marked as a map: this is the user saying so when zone detection can't.
        await ensureActiveSession(settings.league, true);
      }
    },
    onForceCapture: () => clipboardWatcher.forceCapture()
  };

  /** Drops every binding and reinstates them from the current `settings`. */
  const applyHotkeys = (): void => {
    unregisterAllHotkeys();
    registerHotkeys(settings, hotkeyHandlers);
  };

  applyHotkeys();

  startLogWatcher(settings);
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
  logWatcher?.stop();
  // Without this the PowerShell helper is orphaned and keeps polling after we're gone.
  foregroundWatcher?.stop();
});
