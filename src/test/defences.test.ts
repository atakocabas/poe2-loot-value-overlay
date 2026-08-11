import assert from "node:assert/strict";
import { test } from "node:test";
import { defencesOf, isLocalDefenceMod } from "../shared/defences";
import type { ItemDefences, ParsedItem } from "../shared/types";

const NONE: ItemDefences = { armour: null, evasion: null, energyShield: null, ward: null };
const BODY_ARMOUR: ItemDefences = { armour: 1081, evasion: null, energyShield: null, ward: null };
const HYBRID: ItemDefences = { armour: 640, evasion: 420, energyShield: null, ward: null };
const ES_CHEST: ItemDefences = { ...NONE, energyShield: 380 };

test("mods folded into a displayed total are not also stat filters", () => {
  // The two that made a real Soldier Cuirass unsearchable: both are pinned to this item's exact
  // roll, and GGG indexes only the total they produced.
  assert.equal(isLocalDefenceMod("+186 to Armour", BODY_ARMOUR), true);
  assert.equal(isLocalDefenceMod("38% increased Armour", BODY_ARMOUR), true);
});

test("the same mod text stays a stat filter when the item displays no such defence", () => {
  // This is the local-vs-global discriminator and the whole reason the predicate takes defences.
  // "+40 to maximum Energy Shield" is local on a chest (inside the Energy Shield: total) and
  // global on a ring — identical text, and only the property line tells them apart.
  assert.equal(isLocalDefenceMod("+40 to maximum Energy Shield", ES_CHEST), true);
  assert.equal(isLocalDefenceMod("+40 to maximum Energy Shield", NONE), false);
  // Same for increased armour on a belt, which has no armour of its own to increase.
  assert.equal(isLocalDefenceMod("38% increased Armour", NONE), false);
});

test("a multi-defence rune folds when any one of the defences it names is displayed", () => {
  // Its armour and evasion halves went into those totals; its ES half had no base to act on, so
  // requiring every named defence to be displayed would wrongly keep the whole line.
  assert.equal(isLocalDefenceMod("36% increased Armour, Evasion and Energy Shield", HYBRID), true);
  assert.equal(isLocalDefenceMod("18% increased Armour and Evasion", HYBRID), true);
  // But a line naming only defences this item hasn't got is still somebody else's stat.
  assert.equal(isLocalDefenceMod("15% increased Energy Shield", BODY_ARMOUR), false);
});

test("mods that merely mention a defence are left alone", () => {
  // Anchored shapes, so a conditional or converting mod is never folded away — those are real
  // separately-indexed stats and no property line accounts for them.
  assert.equal(isLocalDefenceMod("Gain 30% of Armour as Extra Energy Shield", BODY_ARMOUR), false);
  assert.equal(isLocalDefenceMod("10% increased Armour during Soul Gain Prevention", BODY_ARMOUR), false);
  assert.equal(isLocalDefenceMod("Has +3 to Evasion Rating per player level", HYBRID), false);
});

test("non-defence mods are never folded, whatever the item shows", () => {
  assert.equal(isLocalDefenceMod("+80 to maximum Life", BODY_ARMOUR), false);
  assert.equal(isLocalDefenceMod("+45% to Fire Resistance", BODY_ARMOUR), false);
  assert.equal(isLocalDefenceMod("+15 to Strength", BODY_ARMOUR), false);
  assert.equal(isLocalDefenceMod("Adds 5 to 10 Physical Damage to Attacks", BODY_ARMOUR), false);
});

test("an item persisted before defences existed reads as no constraint, not a crash", () => {
  // loot-cache.json is read back with no migration, so `defences` is simply absent on old rows.
  // All-null means "no defence filter", which is exactly how this app searched before.
  const legacy = { name: "Doom Grip" } as unknown as ParsedItem;
  assert.deepEqual(defencesOf(legacy), NONE);
  assert.deepEqual(defencesOf({ defences: BODY_ARMOUR } as ParsedItem), BODY_ARMOUR);
});
