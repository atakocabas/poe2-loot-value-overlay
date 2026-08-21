import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  findDuplicateAccelerators,
  normalizeAccelerator,
  validateAccelerator
} from "../shared/accelerator";

describe("validateAccelerator", () => {
  test("accepts the shipped defaults", () => {
    assert.equal(validateAccelerator("CommandOrControl+Shift+O"), null);
    assert.equal(validateAccelerator("CommandOrControl+Shift+M"), null);
    // The backtick is a bare punctuation key, not a named one — easy to drop from a key table.
    assert.equal(validateAccelerator("CommandOrControl+`"), null);
  });

  test("treats an empty accelerator as disabled rather than broken", () => {
    // This is what the settings window's Clear button writes; `registerHotkeys` skips it.
    assert.equal(validateAccelerator(""), null);
  });

  test("rejects a bare key", () => {
    // A global shortcut is taken from every app, so an unmodified letter would be swallowed
    // system-wide — including from PoE2's own chat box.
    assert.match(validateAccelerator("G") ?? "", /modifier/i);
    assert.match(validateAccelerator("F5") ?? "", /modifier/i);
  });

  test("rejects modifiers with no key", () => {
    assert.match(validateAccelerator("CommandOrControl+Shift") ?? "", /key/i);
  });

  test("rejects two keys in one combination", () => {
    assert.match(validateAccelerator("CommandOrControl+O+P") ?? "", /one key/i);
  });

  test("rejects a key name Electron doesn't have", () => {
    assert.match(validateAccelerator("CommandOrControl+Banana") ?? "", /isn't a key/i);
  });

  test("rejects a malformed string rather than reading an empty token as a key", () => {
    assert.notEqual(validateAccelerator("CommandOrControl+"), null);
    assert.notEqual(validateAccelerator("+O"), null);
  });

  test("accepts function, numpad and arrow keys", () => {
    assert.equal(validateAccelerator("Alt+F12"), null);
    assert.equal(validateAccelerator("Alt+num5"), null);
    assert.equal(validateAccelerator("Alt+numdec"), null);
    assert.equal(validateAccelerator("Shift+Up"), null);
    assert.equal(validateAccelerator("Alt+F24"), null);
    assert.notEqual(validateAccelerator("Alt+F25"), null);
  });
});

describe("normalizeAccelerator", () => {
  test("collapses the Windows spellings of one combination", () => {
    // CommandOrControl *is* Control on Windows, so these are one combo and the second binding of it
    // would be silently refused.
    const canonical = normalizeAccelerator("CommandOrControl+Shift+O");
    assert.equal(normalizeAccelerator("Ctrl+Shift+O"), canonical);
    assert.equal(normalizeAccelerator("Control+Shift+o"), canonical);
    assert.equal(normalizeAccelerator("Shift+CommandOrControl+O"), canonical);
  });

  test("keeps genuinely different combinations apart", () => {
    assert.notEqual(
      normalizeAccelerator("CommandOrControl+Shift+O"),
      normalizeAccelerator("Alt+Shift+O")
    );
    assert.notEqual(
      normalizeAccelerator("CommandOrControl+O"),
      normalizeAccelerator("CommandOrControl+Shift+O")
    );
  });
});

describe("findDuplicateAccelerators", () => {
  test("the shipped defaults are all valid and none collide", () => {
    // Read from the file rather than restated here, so this can't quietly go stale — it is the guard
    // against shipping a clash, and a copy of the three (now four) names would have to be remembered
    // every time one is added. `settings.default.json` is what every install starts from.
    const defaults = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "config", "settings.default.json"), "utf-8")
    ) as { hotkeys: Record<string, string> };

    for (const [name, accelerator] of Object.entries(defaults.hotkeys)) {
      assert.equal(validateAccelerator(accelerator), null, `${name} (${accelerator}) is not valid`);
    }
    assert.deepEqual(findDuplicateAccelerators(defaults.hotkeys), []);
    // A default that shipped empty would be a hotkey nobody knows is disabled.
    assert.ok(Object.values(defaults.hotkeys).every((a) => a !== ""));
  });

  test("names both hotkeys sharing a combination, however each is spelled", () => {
    assert.deepEqual(
      findDuplicateAccelerators({
        toggleOverlay: "CommandOrControl+Shift+O",
        toggleList: "Ctrl+Shift+O",
        forceCapture: "CommandOrControl+`"
      }),
      ["toggleOverlay", "toggleList"]
    );
  });

  test("does not count two disabled hotkeys as sharing anything", () => {
    assert.deepEqual(
      findDuplicateAccelerators({
        toggleOverlay: "",
        toggleList: "",
        forceCapture: "CommandOrControl+`"
      }),
      []
    );
  });
});
