import assert from "node:assert/strict";
import { test } from "node:test";
import { ForegroundWatcher } from "../main/foreground-watch";

/** Never spawns the PowerShell helper — tests drive `handleLine` directly instead. */
function watcher(): { watcher: ForegroundWatcher; events: string[] } {
  const w = new ForegroundWatcher(["PathOfExileSteam.exe", "PathOfExile_x64Steam.exe"], 400, () => ({
    stop: () => {}
  }));
  const events: string[] = [];
  w.on("focused", () => events.push("focused"));
  w.on("unfocused", () => events.push("unfocused"));
  w.on("unavailable", () => events.push("unavailable"));
  return { watcher: w, events };
}

const GAME = "12345|PathOfExile_x64Steam";
const BROWSER = "6789|chrome";

test("emits focused once when the game takes the foreground, even across repeated polls", () => {
  const { watcher: w, events } = watcher();

  w.handleLine(BROWSER);
  w.handleLine(GAME);
  w.handleLine(GAME);
  w.handleLine(GAME);

  assert.deepEqual(events, ["focused"]);
});

test("emits unfocused once after the game loses the foreground", () => {
  const { watcher: w, events } = watcher();

  w.handleLine(GAME);
  w.handleLine(BROWSER);
  w.handleLine(BROWSER);

  assert.deepEqual(events, ["focused", "unfocused"]);
});

test("matches the target regardless of .exe suffix or casing", () => {
  const { watcher: w, events } = watcher();

  // Win32 reports the name without .exe, while settings carry it — and casing varies either way.
  w.handleLine("11|pathofexile_x64steam");
  assert.deepEqual(events, ["focused"]);

  w.handleLine("11|chrome");
  w.handleLine("11|PathOfExile_x64Steam.EXE");
  assert.deepEqual(events, ["focused", "unfocused", "focused"]);
});

test("an unresolvable foreground process counts as not focused", () => {
  const { watcher: w, events } = watcher();

  w.handleLine(GAME);
  w.handleLine("0|"); // nothing focused, or a process we can't inspect

  assert.deepEqual(events, ["focused", "unfocused"]);
});

test("malformed helper output is ignored rather than treated as a focus change", () => {
  const { watcher: w, events } = watcher();

  w.handleLine(GAME);
  w.handleLine("Add-Type : something went wrong");
  w.handleLine("not-a-pid|chrome");
  w.handleLine("");

  assert.deepEqual(events, ["focused"]);
});

test("a helper failure reports unavailable once and does not flip focus state", () => {
  const { watcher: w, events } = watcher();

  w.handleLine(GAME);
  w.handleHelperFailure("powershell.exe not found");
  w.handleHelperFailure("powershell.exe not found");

  // "focused" is still the last focus event: an unusable helper must not imply "not focused",
  // otherwise a blocked PowerShell would hide the overlay permanently.
  assert.deepEqual(events, ["focused", "unavailable"]);
});
