import assert from "node:assert/strict";
import { test } from "node:test";
import { modsOf } from "../shared/mods";
import type { ParsedItem } from "../shared/types";

/** An item as `loot-cache.json` stored it before `mods` existed — no migration step runs on load. */
const LEGACY_ITEM = {
  implicitMods: ["+20% to Lightning Resistance"],
  explicitMods: ["+80 to maximum Life", "18% increased Armour"]
} as unknown as Pick<ParsedItem, "mods" | "implicitMods" | "explicitMods">;

test("a legacy stored item still yields usable mods instead of undefined", () => {
  assert.deepEqual(modsOf(LEGACY_ITEM), [
    { text: "+20% to Lightning Resistance", kind: "implicit" },
    { text: "+80 to maximum Life", kind: "explicit" },
    { text: "18% increased Armour", kind: "explicit" }
  ]);
});

test("a freshly parsed item's own kinds win over the reconstruction", () => {
  const item = {
    mods: [{ text: "18% increased Armour", kind: "rune" as const }],
    implicitMods: [],
    explicitMods: ["18% increased Armour"]
  };

  assert.deepEqual(modsOf(item), [{ text: "18% increased Armour", kind: "rune" }]);
});

test("an item with no mods at all is empty, not a crash", () => {
  assert.deepEqual(modsOf({ mods: [], implicitMods: [], explicitMods: [] }), []);
  assert.deepEqual(modsOf({} as Parameters<typeof modsOf>[0]), []);
});
