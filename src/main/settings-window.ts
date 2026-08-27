import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { IPC } from "../shared/ipc-channels";
import { findDuplicateAccelerators, validateAccelerator } from "../shared/accelerator";
import { appIcon } from "./icon";
import { probeAccelerator, unregisterAllHotkeys } from "./hotkeys";
import { loadDefaultSettings, loadSettings, saveSettings } from "./settings";
import { pipeRendererLogs } from "./window";
import type { Settings } from "../shared/settings";
import type { SettingsConfig, SettingsSaveResult, SettingsState } from "../shared/types";

let settingsWindow: BrowserWindow | null = null;
/**
 * The pending "this window has closed" promise, so a second `showSettingsWindow()` call hands back
 * the *same* one rather than a resolved one. Without it, re-opening an already-open window ran the
 * caller's `.then()` on the next microtask — reinstating the hotkeys behind the open window's back,
 * which is the one state this window must never be in.
 */
let settingsClosed: Promise<void> | null = null;

/** The settings-window half of `Settings` — see `SettingsConfig` for why it's only this half. */
function toConfig(settings: Settings): SettingsConfig {
  return {
    hotkeys: { ...settings.hotkeys },
    overlay: {
      hideWhenGameUnfocused: settings.overlay.hideWhenGameUnfocused,
      hideDelayMs: settings.overlay.hideDelayMs,
      panel: { ...settings.overlay.panel }
    },
    display: { currency: settings.display.currency },
    trade2: {
      saleType: settings.trade2.saleType,
      listingStatus: settings.trade2.listingStatus,
      useMapFilters: settings.trade2.useMapFilters,
      mapMinRatio: settings.trade2.mapMinRatio
    }
  };
}

/**
 * The settings window: hotkeys, overlay behaviour, the display currency and the two trade search
 * filters — everything that applies the moment it is saved.
 *
 * Framed, opaque, focusable and not always-on-top, exactly like the setup window and for the same
 * reason — it is not the second *overlay* the "one window" non-goal rules out, which is about two
 * full-screen always-on-top sheets fighting over clicks (see `createOverlayWindow`). It shows no loot
 * data, and it never takes clicks away from the overlay — which does stay on screen behind it, so
 * the panel size and position chosen in here can be seen (`configWindowOpen` in
 * `overlay-visibility.ts`).
 *
 * Separate from the setup window rather than a fourth field on it, because the two halves of the
 * configuration are applied in opposite ways: everything here takes effect in place, while the
 * league and contact email were captured at construction by three pricing clients and need a
 * relaunch. One window doing both would have to restart for every change or lie about which ones.
 *
 * **The global hotkeys are suspended while a key recorder in here is armed**, not for the window's
 * whole lifetime: the page says so over `SET_HOTKEY_CAPTURE`, and the save handler below drops them
 * itself around its probe loop. A registered accelerator is taken by the OS before any renderer sees
 * it, so a recorder cannot capture a combo that is currently bound and `probeAccelerator` would
 * report every existing binding as unavailable — but neither is a reason to leave them down while
 * the user is filling in the rest of the form.
 */
export function showSettingsWindow(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    // The promise from the call that opened it, never a fresh resolved one — see `settingsClosed`.
    return settingsClosed ?? Promise.resolve();
  }

  settingsWindow = new BrowserWindow({
    // Content size for the same reason as the setup window: title bar and border thickness vary with
    // the user's Windows theme and DPI, so sizing the frame clips the Save button on other machines.
    useContentSize: true,
    width: 560,
    height: 680,
    minWidth: 460,
    minHeight: 420,
    resizable: true,
    frame: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    backgroundColor: "#14161c",
    // The overlay window is frameless and skipTaskbar, so this and the setup window are the only
    // two places the app's mark can appear while it is running.
    icon: appIcon(),
    title: "PoE2 Loot Value Overlay — Settings",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  pipeRendererLogs(settingsWindow, "settings");
  settingsWindow.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));

  settingsClosed = new Promise((resolve) => {
    settingsWindow?.on("closed", () => {
      settingsWindow = null;
      settingsClosed = null;
      resolve();
    });
  });
  return settingsClosed;
}

export interface SettingsIpcDeps {
  /**
   * Called with the saved values, for the main process to apply in place. A callback rather than
   * reaching back into `index.ts`, matching `onSetupSaved` and `onHistoryCleared` — but unlike
   * `onSetupSaved` this one really does apply them, since nothing downstream captured any of it.
   *
   * That includes re-registering the hotkeys, which the save handler below drops around its probe
   * loop. The window staying open is no longer a reason to leave them down — the suspension is
   * scoped to an armed recorder now, and `onHotkeyCapture` is what holds it.
   */
  onSettingsSaved: (settings: Settings) => void;
  /**
   * A key recorder in the page was armed (true) or disarmed (false), for as long as which the caller
   * must drop every binding. See `SET_HOTKEY_CAPTURE`.
   *
   * The caller is also responsible for clearing it when this window closes: a window shut mid-record
   * never sends the false, and the hotkeys would stay down for the rest of the session.
   */
  onHotkeyCapture: (active: boolean) => void;
}

export function registerSettingsIpcHandlers({
  onSettingsSaved,
  onHotkeyCapture
}: SettingsIpcDeps): void {
  ipcMain.handle(IPC.GET_SETTINGS_CONFIG, async (): Promise<SettingsState> => {
    return { ...toConfig(loadSettings()), defaults: toConfig(loadDefaultSettings()) };
  });

  ipcMain.handle(IPC.SET_HOTKEY_CAPTURE, (_event, active: boolean): void => {
    onHotkeyCapture(active === true);
  });

  ipcMain.handle(
    IPC.SAVE_SETTINGS_CONFIG,
    (_event, config: SettingsConfig): SettingsSaveResult => {
      const hotkeys = config.hotkeys as unknown as Record<string, string>;

      // Nothing is written when a combo is unusable: a half-saved settings.json where three of four
      // hotkeys changed is harder to reason about than a form that simply didn't take.
      const invalid: SettingsSaveResult["invalid"] = [];
      for (const [name, accelerator] of Object.entries(hotkeys)) {
        const reason = validateAccelerator(accelerator);
        if (reason) invalid.push({ name, accelerator, reason });
      }
      for (const name of findDuplicateAccelerators(hotkeys)) {
        if (invalid.some((entry) => entry.name === name)) continue;
        invalid.push({
          name,
          accelerator: hotkeys[name],
          reason: "Two hotkeys can't share one combination."
        });
      }
      if (invalid.length > 0) {
        console.warn(
          `[settings] not saved — ${invalid.map((e) => `${e.name}: ${e.reason}`).join("; ")}`
        );
        return { invalid, refused: [] };
      }

      // Dropped here rather than relied on being down already: `probeAccelerator` reports a combo
      // this app has bound as taken — by itself — so the probe below is only honest with nothing
      // registered. Doing it inside the handler makes that true whether or not a recorder happens
      // to be armed; `onSettingsSaved` at the end puts the new bindings back.
      unregisterAllHotkeys();
      const refused: SettingsSaveResult["refused"] = [];
      for (const [name, accelerator] of Object.entries(hotkeys)) {
        if (!probeAccelerator(accelerator)) refused.push({ name, accelerator });
      }

      // Read-modify-write of the whole object, as SAVE_SETUP_CONFIG does — `saveSettings` writes
      // whatever it is handed, so anything omitted here would be dropped from settings.json.
      const settings = loadSettings();
      const next: Settings = {
        ...settings,
        hotkeys: { ...config.hotkeys },
        overlay: {
          ...settings.overlay,
          hideWhenGameUnfocused: config.overlay.hideWhenGameUnfocused,
          hideDelayMs: config.overlay.hideDelayMs,
          panel: { ...config.overlay.panel }
        },
        display: { ...settings.display, currency: config.display.currency },
        // Spread first: every other trade2 key is a tuning knob this window doesn't show, and
        // rebuilding the block from the form would erase them from settings.json.
        trade2: {
          ...settings.trade2,
          saleType: config.trade2.saleType,
          listingStatus: config.trade2.listingStatus,
          useMapFilters: config.trade2.useMapFilters,
          mapMinRatio: config.trade2.mapMinRatio
        }
      };
      saveSettings(next);

      console.log(
        `[settings] saved: hotkeys=${Object.entries(next.hotkeys)
          .map(([name, accelerator]) => `${name}=${accelerator || "(none)"}`)
          .join(" ")}, panel=${next.overlay.panel.width}x${next.overlay.panel.maxHeightPercent}% ` +
          `${next.overlay.panel.position}, ` +
          `currency=${next.display.currency}, hideWhenGameUnfocused=${next.overlay.hideWhenGameUnfocused}, ` +
          `saleType=${next.trade2.saleType}, listingStatus=${next.trade2.listingStatus}, ` +
          `useMapFilters=${next.trade2.useMapFilters}, mapMinRatio=${next.trade2.mapMinRatio}`
      );
      if (refused.length > 0) {
        console.warn(
          `[settings] the OS refused ${refused
            .map((entry) => `${entry.name} (${entry.accelerator})`)
            .join(", ")} — saved anyway, they'll bind once whatever holds them is closed`
        );
      }

      // Applied — including re-registering the hotkeys dropped above — but the window stays open:
      // this is a live apply, not a wizard step.
      onSettingsSaved(next);
      return { invalid: [], refused };
    }
  );
}
