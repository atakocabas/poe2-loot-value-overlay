import assert from "node:assert/strict";
import { test } from "node:test";
import { elementalDpsOf, isLocalElementalDamageMod, weaponStatsOf } from "../shared/weapon-stats";
import { parseItemText } from "../parser/item-text-parser";
import type { ItemWeaponStats, ParsedItem } from "../shared/types";

function parse(rawText: string): ParsedItem {
  const item = parseItemText(rawText);
  assert.ok(item);
  return item!;
}

/**
 * A quarterstaff carrying both damage lines, in the shape the clipboard prints them.
 *
 * The base is real and so are the numbers: a live `edps >= 300` search returned a Bolting
 * Quarterstaff printing `Elemental Damage: 45-69, 17-370` at 1.54 attacks per second — 250.5 per
 * hit, 385.8 eDPS — which is also the confirmation that this formula is the one GGG indexes.
 * Wands are the wrong base to reach for here: measured live, every Attuned Wand listing has zero
 * elemental DPS, because a wand's added elemental damage is spell damage.
 */
function weapon(properties: string, ...mods: string[]): ParsedItem {
  return parse(
    "Item Class: Quarterstaves\nRarity: Rare\nBrood Song\nBolting Quarterstaff\n--------\n" +
      `${properties}\n--------\nItem Level: 79\n--------\n${mods.join("\n")}`
  );
}

const RING_STATS: ItemWeaponStats = { elementalDamage: null, attacksPerSecond: null };

test("elemental DPS is the printed damage times the printed attack rate", () => {
  const staff = weapon(
    "Physical Damage: 29-117\nElemental Damage: 45-69 (augmented)\nCritical Hit Chance: 10.00%\n" +
      "Attacks per Second: 1.54"
  );

  // 45-69 averages 57, which is the damage per hit GGG folds into its own eDPS.
  assert.equal(weaponStatsOf(staff).elementalDamage, 57);
  assert.equal(weaponStatsOf(staff).attacksPerSecond, 1.54);
  assert.equal(elementalDpsOf(staff), 87.78);
});

test("every range on the line is summed, since one weapon can roll two elements", () => {
  const staff = weapon(
    "Elemental Damage: 45-69 (augmented), 17-370 (augmented)\nAttacks per Second: 1.54"
  );

  // The real listing above: 57 + 193.5 = 250.5 per hit, 385.77 eDPS — which is why it came back
  // from an `edps >= 300` search. Taking only the first range would understate it by three
  // quarters and leave the floor asking for a far weaker weapon.
  assert.equal(weaponStatsOf(staff).elementalDamage, 250.5);
  assert.equal(elementalDpsOf(staff), 385.77);
});

test("an item printing neither line has no elemental DPS to search on", () => {
  const ring = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      "--------\n+80 to maximum Life"
  );

  assert.deepEqual(weaponStatsOf(ring), RING_STATS);
  assert.equal(elementalDpsOf(ring), null);
});

test("one factor without the other is a missed line, not a number worth inventing", () => {
  const noRate = weapon("Elemental Damage: 45-69");
  assert.equal(weaponStatsOf(noRate).elementalDamage, 57);
  assert.equal(elementalDpsOf(noRate), null);

  const noDamage = weapon("Attacks per Second: 1.54");
  assert.equal(elementalDpsOf(noDamage), null);
});

test("reads an item persisted before the weapon block was parsed", () => {
  // Nothing migrates loot-cache.json, so this has to go through weaponStatsOf rather than the field.
  const legacy = { explicitMods: ["Adds 45 to 69 Fire Damage"] } as unknown as ParsedItem;

  assert.deepEqual(weaponStatsOf(legacy), RING_STATS);
  assert.equal(elementalDpsOf(legacy), null);
});

test("a weapon's flat elemental rolls are already inside its printed damage", () => {
  const staff = weaponStatsOf(weapon("Elemental Damage: 45-69\nAttacks per Second: 1.54"));

  assert.equal(isLocalElementalDamageMod("Adds 45 to 69 Fire Damage", staff), true);
  assert.equal(isLocalElementalDamageMod("Adds 17 to 370 Cold Damage", staff), true);
  assert.equal(isLocalElementalDamageMod("Adds 3 to 60 Lightning Damage", staff), true);
});

test("the same text on an item with no damage line is a stat of its own", () => {
  // A ring's `Adds # to # Fire Damage to Attacks` is global — no property line absorbs it, so folding
  // it away would delete the stat and put nothing in its place. Two guards catch it: the missing
  // damage line, and the tail the anchored pattern rejects.
  assert.equal(isLocalElementalDamageMod("Adds 5 to 9 Fire Damage to Attacks", RING_STATS), false);
  assert.equal(
    isLocalElementalDamageMod("Adds 5 to 9 Fire Damage to Attacks", {
      elementalDamage: 57,
      attacksPerSecond: 1.54
    }),
    false
  );
});

test("increased elemental damage never folds, because it doesn't move the printed line", () => {
  const staff = weaponStatsOf(weapon("Elemental Damage: 45-69\nAttacks per Second: 1.54"));

  // Unlike `#% increased Armour`, which really is inside the armour total. Folding this would search
  // it with nothing at all.
  assert.equal(isLocalElementalDamageMod("35% increased Elemental Damage", staff), false);
  assert.equal(isLocalElementalDamageMod("Adds 29 to 117 Physical Damage", staff), false);
  assert.equal(isLocalElementalDamageMod("Gain 20% of Damage as Extra Fire Damage", staff), false);
});
