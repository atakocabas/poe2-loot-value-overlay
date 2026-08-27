import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldShowOverlay, type OverlayVisibilityState } from "../main/overlay-visibility";

const hidden: OverlayVisibilityState = {
  gameRunning: true,
  followFocus: true,
  gameFocused: false,
  interactive: false,
  overlayFocused: false,
  configWindowOpen: false,
  trayOverride: null
};

test("follows the game's focus while focus-following is active", () => {
  assert.equal(shouldShowOverlay({ ...hidden, gameFocused: true }), true);
  assert.equal(shouldShowOverlay(hidden), false);
});

test("stays visible while the user is using the overlay itself", () => {
  // Interactive mode is how the list gets read — hiding it out from under the user would make
  // the panel unusable the moment they clicked into it.
  assert.equal(shouldShowOverlay({ ...hidden, interactive: true }), true);
  assert.equal(shouldShowOverlay({ ...hidden, overlayFocused: true }), true);
});

test("the tray override keeps it visible with the game unfocused", () => {
  assert.equal(shouldShowOverlay({ ...hidden, trayOverride: "show" }), true);
});

test("tray Hide beats the fail-open branch, so the menu item is never a no-op", () => {
  // With followFocus false the rule returns true unconditionally, which is deliberate (broken
  // focus detection must not make the overlay unreachable). A tray Hide still has to win, or the
  // only way to dismiss the panel in that configuration would be quitting the app.
  assert.equal(shouldShowOverlay({ ...hidden, followFocus: false, trayOverride: "hide" }), false);
  assert.equal(
    shouldShowOverlay({ ...hidden, gameFocused: true, interactive: true, trayOverride: "hide" }),
    false
  );
});

test("hides once PoE2 is no longer running", () => {
  // The regression: focus-following turns itself off on game exit, and treating that as "focus
  // detection is unavailable" left the overlay pinned on top of the desktop with no way to
  // dismiss it short of quitting the app.
  assert.equal(shouldShowOverlay({ ...hidden, gameRunning: false, followFocus: false }), false);
  // Nothing about the game being closed should be overridden by leftover in-game state.
  assert.equal(
    shouldShowOverlay({ ...hidden, gameRunning: false, followFocus: false, interactive: true }),
    false
  );
});

test("stays visible with focus-following off while the game is running", () => {
  // Two distinct cases share followFocus: false — the hideWhenGameUnfocused setting being disabled,
  // and the foreground helper being unavailable. Both must fail open, or broken focus detection
  // would make the overlay permanently unreachable.
  assert.equal(shouldShowOverlay({ ...hidden, followFocus: false }), true);
});

test("the tray override still works with the game closed, for reading the list", () => {
  assert.equal(
    shouldShowOverlay({ ...hidden, gameRunning: false, followFocus: false, trayOverride: "show" }),
    true
  );
});

test("stays visible while a config window is open, so the panel can be seen being configured", () => {
  // The settings window takes the OS foreground and is not PoE2, so the foreground watcher reports
  // the game unfocused the moment it opens. Panel width, position and currency all apply live on
  // Save — onto a window the user could otherwise no longer see.
  assert.equal(shouldShowOverlay({ ...hidden, configWindowOpen: true }), true);
});

test("a config window doesn't outrank tray Hide or the game being closed", () => {
  // Both checks sit above it in the rule, and for reasons that have already been regressions once:
  // tray Hide must never be a no-op, and nothing may pin a full-screen sheet over the bare desktop.
  assert.equal(
    shouldShowOverlay({ ...hidden, configWindowOpen: true, trayOverride: "hide" }),
    false
  );
  assert.equal(
    shouldShowOverlay({ ...hidden, configWindowOpen: true, gameRunning: false, followFocus: false }),
    false
  );
});
