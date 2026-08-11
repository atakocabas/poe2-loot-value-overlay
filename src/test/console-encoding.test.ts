import assert from "node:assert/strict";
import { test } from "node:test";
import { asciiSafe } from "../main/console-encoding";

test("the em dash that broke a real log line becomes a hyphen", () => {
  const line = '[pricing] "Torment Knuckle" unpriced — trade2 search returned HTTP 502';

  // Printed verbatim on a cp850 console this reads "unpriced ΓÇö trade2 ...".
  assert.equal(
    asciiSafe(line),
    '[pricing] "Torment Knuckle" unpriced - trade2 search returned HTTP 502'
  );
});

test("curly quotes, ellipses, arrows and nbsp are all rendered safely", () => {
  assert.equal(asciiSafe("‘a’ “b”… x → y"), "'a' \"b\"... x -> y");
  assert.equal(asciiSafe("a b"), "a b");
});

test("accented item names are folded, not printed as mojibake", () => {
  // The real log line that surfaced this read `"Ois├¡n's Oath" unpriced` on a cp850 console.
  assert.equal(asciiSafe("[pricing] \"Oisín's Oath\" unpriced"), '[pricing] "Oisin\'s Oath" unpriced');
  assert.equal(asciiSafe("Mjölner"), "Mjolner");
  assert.equal(asciiSafe("Mórrigan's Insight"), "Morrigan's Insight");
});

test("a character with no ASCII reading becomes one '?', not a run of bytes", () => {
  assert.equal(asciiSafe("Ærø 東"), "?r? ?");
});

test("plain ASCII, including item and zone names, is left exactly alone", () => {
  const untouched = "[map] zone changed: \"Fists of Stone\" (hideout/atlas) 100% +2.33";

  assert.equal(asciiSafe(untouched), untouched);
});
