export interface OverlayVisibilityState {
  /** PoE2 is running at all, per ProcessWatcher. */
  gameRunning: boolean;
  /**
   * Whether focus-following is active at all: the `overlay.hideWhenGameUnfocused` setting is on
   * *and* the foreground watcher is actually running. False therefore means either the user opted
   * out of auto-hide, or focus detection turned out to be unavailable — and both fail open, so a
   * broken PowerShell helper can never make the overlay unreachable.
   *
   * It deliberately does *not* mean "the game is closed" any more; that's `gameRunning`. The two
   * used to share this flag, which is why closing PoE2 pinned the overlay to the desktop.
   */
  followFocus: boolean;
  /** PoE2 is the OS foreground window. */
  gameFocused: boolean;
  /** The overlay is in interactive mode (the expanded panel) — the user is clicking around in it. */
  interactive: boolean;
  /** The overlay window itself holds OS focus. */
  overlayFocused: boolean;
  /**
   * Explicit tray choice, overriding everything below it, and cleared the next time PoE2 takes
   * focus (or when the game exits).
   *
   * Tri-state rather than a `manualShow` boolean because "hide" has to beat the fail-open
   * `!followFocus` branch: with focus detection off or unavailable that branch returns true
   * unconditionally, so a boolean "not showing" left the tray's Hide item doing nothing at all.
   */
  trayOverride: "show" | "hide" | null;
}

/**
 * The single rule for whether the overlay should be on screen. Kept pure and electron-free (like
 * `classifyZone` in logwatch.ts) so it's unit-testable; the actual show/hide calls live in
 * window.ts.
 */
export function shouldShowOverlay(state: OverlayVisibilityState): boolean {
  // An explicit tray choice wins outright, including while the game is closed — that's how
  // the list stays reachable after a session, and how the panel can be dismissed without quitting.
  if (state.trayOverride !== null) return state.trayOverride === "show";

  // Nothing to overlay when the game isn't running. Checked *before* followFocus: focus-following
  // switches itself off on game exit, and treating that the same as "focus detection is broken"
  // is what left the overlay pinned on top of the desktop with no way to dismiss it.
  if (!state.gameRunning) return false;

  if (!state.followFocus) return true;
  return state.gameFocused || state.interactive || state.overlayFocused;
}
