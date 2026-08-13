import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { IPC } from "../shared/ipc-channels";
import { findDuplicateAccelerators, validateAccelerator } from "../shared/accelerator";
import { probeAccelerator } from "./hotkeys";
import { loadDefaultSettings, loadSettings, saveSettings } from "./settings";
import { pipeRendererLogs } from "./window";
import type { Settings } from "../shared/settings";
import type { SettingsConfig, SettingsSaveResult, SettingsState } from "../shared/types";

let settingsWindow: BrowserWindow | null = null;

/** The settings-window half of `Settings` — see `SettingsConfig` for why it's only this half. */
function toConfig(settings: Settings): SettingsConfig {
  return {
    hotkeys: { ...settings.hotkeys },
    overlay: {
      hideWhenGameUnfocused: settings.overlay.hideWhenGameUnfocused,
      hideDelayMs: settings.overlay.hideDelayMs,
      panel: { ...settings.overlay.panel }
    },
    display: { currency: settings.display.currency }
  };
}

/**
 * The settings window: hotkeys, overlay behaviour and the display currency.
 *
 * Framed, opaque, focusable and not always-on-top, exactly like the setup window and for the same
 * reason — it is not the second *overlay* the "one window" non-goal rules out, which is about two
 * full-screen always-on-top sheets fighting over clicks (see `createOverlayWindow`). It shows no loot
 * data and is only open while the user isn't playing.
 *
 * Separate from the setup window rather than a fourth field on it, because the two halves of the
 * configuration are applied in opposite ways: everything here takes effect in place, while the
 * league and contact email were captured at construction by three pricing clients and need a
 * relaunch. One window doing both would have to restart for every change or lie about which ones.
 *
 * **The caller must suspend the global hotkeys for as long as this is open** — see `onOpenSettings`
 * in `index.ts`. A registered accelerator is taken by the OS before any renderer sees it, so the key
 * recorder cannot capture a combo that is currently bound, and `probeAccelerator` would report every
 * existing binding as unavailable.
 */
export function showSettingsWindow(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return Promise.resolve();
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

  return new Promise((resolve) => {
    settingsWindow?.on("closed", () => {
      settingsWindow = null;
      resolve();
    });
  });
}

export interface SettingsIpcDeps {
  /**
   * Called with the saved values, for the main process to apply in place. A callback rather than
   * reaching back into `index.ts`, matching `onSetupSaved` and `onHistoryCleared` — but unlike
   * `onSetupSaved` this one really does apply them, since nothing downstream captured any of it.
   *
   * It deliberately does **not** re-register the hotkeys: the window is still open at this point and
   * they are suspended for as long as it is.
   */
  onSettingsSaved: (settings: Settings) => void;
}

export function registerSettingsIpcHandlers({ onSettingsSaved }: SettingsIpcDeps): void {
  ipcMain.handle(IPC.GET_SETTINGS_CONFIG, async (): Promise<SettingsState> => {
    return { ...toConfig(loadSettings()), defaults: toConfig(loadDefaultSettings()) };
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

      // Accurate only because our own hotkeys are unregistered while this window is open.
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
        display: { ...settings.display, currency: config.display.currency }
      };
      saveSettings(next);

      console.log(
        `[settings] saved: hotkeys=${Object.entries(next.hotkeys)
          .map(([name, accelerator]) => `${name}=${accelerator || "(none)"}`)
          .join(" ")}, panel=${next.overlay.panel.width}x${next.overlay.panel.maxHeightPercent}% ` +
          `${next.overlay.panel.position}, ` +
          `currency=${next.display.currency}, hideWhenGameUnfocused=${next.overlay.hideWhenGameUnfocused}`
      );
      if (refused.length > 0) {
        console.warn(
          `[settings] the OS refused ${refused
            .map((entry) => `${entry.name} (${entry.accelerator})`)
            .join(", ")} — saved anyway, they'll bind once whatever holds them is closed`
        );
      }

      // Applied, but the window stays open: this is a live apply, not a wizard step.
      onSettingsSaved(next);
      return { invalid: [], refused };
    }
  );
}
