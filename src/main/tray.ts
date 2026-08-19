import { Tray, Menu } from "electron";
import { trayIcon } from "./icon";
import type { AvailableUpdate } from "./update-check";

export interface TrayActions {
  onShowOverlay: () => void;
  onHideOverlay: () => void;
  /** Hotkeys, overlay behaviour and display currency — everything that applies without a restart. */
  onOpenSettings: () => void;
  /** Reopens the first-run setup window — the only route to the league, log path and contact email. */
  onOpenSetup: () => void;
  /**
   * Opens the release page for the update this menu is currently advertising.
   *
   * A callback rather than the URL, so this file imports no `shell` and handles no link: `index.ts`
   * holds the `AvailableUpdate` and does the `openExternal`, keeping every URL this app opens
   * assembled and opened in one place — the same rule the `OPEN_TRADE_SEARCH` comment in
   * `shared/ipc-channels.ts` states for the renderer.
   */
  onOpenReleases: () => void;
  onQuit: () => void;
}

/** The tray, plus the one thing about its menu that changes after construction. */
export interface TrayHandle {
  tray: Tray;
  /**
   * Adds, replaces or removes the "Update available" row. Rebuilds the whole menu, since Electron's
   * `Menu` is immutable once built — which is also why the template lives in a closure rather than
   * inline, so the two forms can't drift apart.
   */
  setUpdateAvailable(update: AvailableUpdate | null): void;
}

/**
 * Named actions rather than positional callbacks: four bare `() => void` parameters in a row are
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
  onOpenReleases,
  onQuit
}: TrayActions): TrayHandle {
  const tray = new Tray(trayIcon());
  tray.setToolTip("PoE2 Loot Value Overlay");

  let update: AvailableUpdate | null = null;

  function applyMenu(): void {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        // At the top and only when there is one. The alternative — a permanent, disabled
        // "You're up to date" row — is a line every user reads on every launch to learn nothing.
        // This is also the surface that persists: the panel's copy is hidden in its resting form.
        ...(update
          ? [
              { label: `Update available: v${update.version}`, click: onOpenReleases },
              { type: "separator" as const }
            ]
          : []),
        { label: "Show Overlay", click: onShowOverlay },
        { label: "Hide Overlay", click: onHideOverlay },
        { type: "separator" as const },
        { label: "Settings…", click: onOpenSettings },
        { label: "Setup…", click: onOpenSetup },
        { type: "separator" as const },
        { label: "Quit", click: onQuit }
      ])
    );
  }

  applyMenu();

  return {
    tray,
    setUpdateAvailable(next) {
      update = next;
      applyMenu();
    }
  };
}
