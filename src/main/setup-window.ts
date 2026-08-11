import { BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { IPC } from "../shared/ipc-channels";
import { detectClientTxtPath } from "./poe2-install";
import { loadSettings, saveSettings } from "./settings";
import { pipeRendererLogs } from "./window";
import type { SetupConfig, SetupState } from "../shared/types";

let setupWindow: BrowserWindow | null = null;

/**
 * The first-run setup window: league, contact email and the path to Client.txt.
 *
 * This is **not** the second overlay window the "one window" non-goal rules out. That rule exists
 * because two full-screen always-on-top sheets cannot both be interactive — whichever sits higher
 * swallows every click across the display (see `createOverlayWindow`). This is an ordinary framed,
 * opaque, focusable window that is only ever open while the user is configuring the app, never
 * while they are playing, and shows none of the loot data. Nothing about it can shadow the overlay.
 *
 * It exists at all because the three values below cannot ship as working defaults — the league
 * rotates, and the other two belong to the machine and the person running it — and the overlay
 * panel has nowhere sensible to ask for them.
 */
export function showSetupWindow(): Promise<void> {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return Promise.resolve();
  }

  setupWindow = new BrowserWindow({
    // Content size, not outer size: the title bar and borders vary with the user's Windows theme
    // and DPI scaling, and sizing the frame instead is how a fixed-height form ends up clipping its
    // own Save button on somebody else's machine. Resizable for the same reason — the explanatory
    // text reflows, so there is no one height that's right everywhere.
    useContentSize: true,
    width: 600,
    height: 700,
    minWidth: 460,
    minHeight: 420,
    resizable: true,
    // Deliberately opposite to the overlay in every respect: framed, opaque, focusable, in the
    // taskbar, and not always-on-top.
    frame: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    backgroundColor: "#14161c",
    title: "PoE2 Loot Value Overlay — Setup",
    // Held back until the renderer has painted, so the first thing the user sees isn't a white flash.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  setupWindow.once("ready-to-show", () => setupWindow?.show());
  pipeRendererLogs(setupWindow, "setup");
  setupWindow.loadFile(path.join(__dirname, "..", "renderer", "setup.html"));

  return new Promise((resolve) => {
    setupWindow?.on("closed", () => {
      setupWindow = null;
      resolve();
    });
  });
}

export interface SetupIpcDeps {
  /**
   * Called after the new values are on disk. A callback rather than reaching back into `index.ts`,
   * matching how `CLEAR_HISTORY` hands back control — on first run the caller carries on booting
   * with them, and from the tray it restarts the app.
   */
  onSetupSaved: (config: SetupConfig) => void;
}

/**
 * Registered separately from the overlay's handlers, and earlier. On first run the setup window has
 * to run to completion *before* the pricing clients exist, and those are what `registerIpcHandlers`
 * needs — so the two can't share a call.
 */
export function registerSetupIpcHandlers({ onSetupSaved }: SetupIpcDeps): void {
  ipcMain.handle(IPC.GET_SETUP_CONFIG, async (): Promise<SetupState> => {
    const settings = loadSettings();
    // Only worth probing the disk when there's no answer already; a configured path that has since
    // gone missing is handled at boot, not here.
    const detected = settings.clientTxtPath ? null : await detectClientTxtPath();

    return {
      league: settings.league,
      contactEmail: settings.trade2.contactEmail,
      clientTxtPath: settings.clientTxtPath || detected || "",
      detectedClientTxtPath: detected,
      setupCompleted: settings.setupCompleted
    };
  });

  ipcMain.handle(IPC.BROWSE_CLIENT_TXT, async (): Promise<string | null> => {
    const settings = loadSettings();
    const options: Electron.OpenDialogOptions = {
      title: "Locate PoE2's Client.txt",
      defaultPath: settings.clientTxtPath || undefined,
      properties: ["openFile"],
      filters: [
        { name: "Client log", extensions: ["txt"] },
        { name: "All files", extensions: ["*"] }
      ]
    };

    // Parented when there's a window to parent to, so the picker is modal to setup rather than a
    // stray top-level dialog the user can lose behind it.
    const result = setupWindow
      ? await dialog.showOpenDialog(setupWindow, options)
      : await dialog.showOpenDialog(options);

    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.SAVE_SETUP_CONFIG, (_event, config: SetupConfig) => {
    const settings = loadSettings();
    saveSettings({
      ...settings,
      league: config.league.trim() || settings.league,
      clientTxtPath: config.clientTxtPath.trim(),
      setupCompleted: true,
      trade2: { ...settings.trade2, contactEmail: config.contactEmail.trim() }
    });

    console.log(
      `[setup] saved: league="${config.league.trim()}", ` +
        `clientTxtPath=${config.clientTxtPath.trim() || "(not set)"}, ` +
        `contactEmail=${config.contactEmail.trim() ? "set" : "(not set)"}`
    );

    onSetupSaved(config);
    setupWindow?.close();
  });
}
