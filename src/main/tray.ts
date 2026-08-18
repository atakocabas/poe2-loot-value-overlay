import { Tray, Menu } from "electron";
import { trayIcon } from "./icon";

export interface TrayActions {
  onShowOverlay: () => void;
  onHideOverlay: () => void;
  /** Hotkeys, overlay behaviour and display currency — everything that applies without a restart. */
  onOpenSettings: () => void;
  /** Reopens the first-run setup window — the only route to the league, log path and contact email. */
  onOpenSetup: () => void;
  onQuit: () => void;
}

/**
 * Named actions rather than positional callbacks: three bare `() => void` parameters in a row are
 * easy to pass in the wrong order, and getting Quit where Hide was meant is not a recoverable
 * mistake.
 *
 * "Hide Overlay" exists because the window is frameless and `skipTaskbar`, so without it the only
 * way to get the panel off the screen is Quit — which ends the session too.
 *
 * Settings and Setup are two entries rather than one because they behave differently on save:
 * Settings applies in place, Setup relaunches the app. Setup is named for the job it does — it is
 * the first-run form, reopened — rather than for being the lesser half of a settings dialog.
 */
export function createTray({
  onShowOverlay,
  onHideOverlay,
  onOpenSettings,
  onOpenSetup,
  onQuit
}: TrayActions): Tray {
  const tray = new Tray(trayIcon());
  tray.setToolTip("PoE2 Loot Value Overlay");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Overlay", click: onShowOverlay },
      { label: "Hide Overlay", click: onHideOverlay },
      { type: "separator" },
      { label: "Settings…", click: onOpenSettings },
      { label: "Setup…", click: onOpenSetup },
      { type: "separator" },
      { label: "Quit", click: onQuit }
    ])
  );
  return tray;
}
