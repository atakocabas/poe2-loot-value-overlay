import { BrowserWindow, screen } from "electron";
import path from "node:path";

let overlayWindow: BrowserWindow | null = null;

/** Shared with the setup window: a renderer that throws is otherwise silent from the main process. */
export function pipeRendererLogs(window: BrowserWindow, tag: string): void {
  window.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[${tag} console] ${message} (${sourceId}:${line})`);
  });
  window.webContents.on("did-fail-load", (_e, code, description) => {
    console.log(`[${tag} did-fail-load] ${code} ${description}`);
  });
}

/**
 * The one overlay window: a full-screen transparent click-through sheet, with the panel itself
 * positioned by CSS inside it.
 *
 * There used to be a second, *sized and movable* window holding the full item list. It is gone —
 * everything is one list on this panel now — but the reason it was sized rather than another
 * full-screen sheet is worth keeping if anyone proposes a second window again: two full-screen
 * always-on-top windows cannot both be interactive, because whichever sits higher swallows every
 * click across the whole display and leaves the other's buttons dead.
 */
export function createOverlayWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  pipeRendererLogs(overlayWindow, "renderer");
  overlayWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Stays hidden until ProcessWatcher detects PoE2 running (or the tray's manual override).
  overlayWindow.hide();

  return overlayWindow;
}

export function sendToOverlay(channel: string, payload: unknown): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel, payload);
}

/** `showInactive` rather than `show` so bringing the overlay back never steals focus from the game. */
export function showOverlay(): void {
  if (!overlayWindow || overlayWindow.isVisible()) return;
  overlayWindow.showInactive();
}

export function hideOverlay(): void {
  if (!overlayWindow || !overlayWindow.isVisible()) return;
  overlayWindow.hide();
}

export function isOverlayFocused(): boolean {
  return overlayWindow?.isFocused() ?? false;
}

/**
 * Toggles between click-through overlay mode and interactive mode — scrolling the item list,
 * pressing the buttons, editing a price.
 */
export function setOverlayInteractive(interactive: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  overlayWindow.setFocusable(interactive);
}
