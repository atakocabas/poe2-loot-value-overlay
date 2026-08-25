import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isInstilledAmulet,
  isInstilledNotable,
  notablesOf
} from "../shared/instilled-notables";
import type { ParsedItem } from "../shared/types";

type NotableItem = Pick<ParsedItem, "mods" | "implicitMods" | "explicitMods">;

test("the two Loathsome Mire bases are instilled amulets, and nothing else is", () => {
  assert.ok(isInstilledAmulet({ baseType: "Twisted Amulet" }));
  assert.ok(isInstilledAmulet({ baseType: "Distorted Amulet" }));
  assert.ok(!isInstilledAmulet({ baseType: "Jade Amulet" }));
  assert.ok(!isInstilledAmulet({ baseType: "Sapphire Ring" }));
});

test("a Magic one is out of reach, because PoE2 glues the affixes onto the base line", () => {
  // Not an oversight and not fixable here: `baseType` for a Magic item is the affixed name, which is
  // the same reason Magic items never reach trade2 at all. Pinned so the exact-name test isn't
  // "loosened" into a substring match, which would start pricing Magic amulets on a base string the
  // resolver never sends.
  assert.ok(!isInstilledAmulet({ baseType: "Rotund Twisted Amulet of the Bear" }));
});

test("an Allocates line is an instilled notable", () => {
  assert.ok(isInstilledNotable("Allocates Doomsayer"));
  assert.ok(isInstilledNotable("Allocates Well of Power"));
  assert.ok(isInstilledNotable("Allocates Zarokh's Gift"));
});

test("the numeric Allocates stat is not a notable", () => {
  // `explicit.stat_3929993388` is "Allocates # Sinister Jewel sockets" — a real stat that starts
  // with the same word. Treating it as a notable would send it to the enchant group, where it does
  // not exist, and lose the filter entirely.
  assert.ok(!isInstilledNotable("Allocates 2 Sinister Jewel sockets"));
  assert.ok(!isInstilledNotable("+80 to maximum Life"));
  assert.ok(!isInstilledNotable("Grants Skill: Allocates Doomsayer"));
});

test("notables are read through modsOf, so an item persisted before mods existed still has them", () => {
  const old: NotableItem = {
    mods: undefined as unknown as ParsedItem["mods"],
    implicitMods: [],
    explicitMods: ["Allocates Doomsayer", "+80 to maximum Life"]
  };

  assert.deepEqual(
    notablesOf(old).map((mod) => mod.text),
    ["Allocates Doomsayer"]
  );
});

test("notablesOf keeps the item's own order, so the two rungs of a split are reproducible", () => {
  const item: NotableItem = {
    mods: [
      { text: "Allocates Blurred Motion", kind: "enchant" },
      { text: "+80 to maximum Life", kind: "explicit" },
      { text: "Allocates Doomsayer", kind: "enchant" }
    ],
    implicitMods: [],
    explicitMods: []
  };

  assert.deepEqual(
    notablesOf(item).map((mod) => mod.text),
    ["Allocates Blurred Motion", "Allocates Doomsayer"]
  );
});
