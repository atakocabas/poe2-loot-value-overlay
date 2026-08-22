import assert from "node:assert/strict";
import { test } from "node:test";
import { tradeCategoryOf } from "../shared/item-category";

/**
 * The whole table, so a typo in a key or an option id fails here rather than showing up in game as a
 * class that quietly keeps searching by base type — which still prices, and so does not look like a
 * failure. The option ids are GGG's, confirmed against `/api/trade2/data/filters`.
 */
const EXPECTED: Array<[string, string]> = [
  ["Rings", "accessory.ring"],
  ["Amulets", "accessory.amulet"],
  ["Belts", "accessory.belt"],
  ["Helmets", "armour.helmet"],
  ["Body Armours", "armour.chest"],
  ["Gloves", "armour.gloves"],
  ["Boots", "armour.boots"],
  ["Shields", "armour.shield"],
  ["Foci", "armour.focus"],
  ["Bucklers", "armour.buckler"],
  ["Quivers", "armour.quiver"],
  ["Wands", "weapon.wand"],
  ["Sceptres", "weapon.sceptre"],
  ["Staves", "weapon.staff"],
  ["Quarterstaves", "weapon.warstaff"],
  ["Bows", "weapon.bow"],
  ["Crossbows", "weapon.crossbow"],
  ["Daggers", "weapon.dagger"],
  ["Claws", "weapon.claw"],
  ["Spears", "weapon.spear"],
  ["Flails", "weapon.flail"],
  ["One Hand Swords", "weapon.onesword"],
  ["One Hand Axes", "weapon.oneaxe"],
  ["One Hand Maces", "weapon.onemace"],
  ["Two Hand Swords", "weapon.twosword"],
  ["Two Hand Axes", "weapon.twoaxe"],
  ["Two Hand Maces", "weapon.twomace"],
  ["Jewels", "jewel"]
];

test("every mapped class resolves to its GGG category option", () => {
  for (const [itemClass, option] of EXPECTED) {
    assert.equal(tradeCategoryOf({ itemClass }), option, itemClass);
  }
});

test("the two that don't read the way they look", () => {
  // `weapon.staff` is the separate Staff class, and swapping the two searches a different weapon
  // entirely. Both are real classes, so neither mistake would error — it would just price wrong.
  assert.equal(tradeCategoryOf({ itemClass: "Quarterstaves" }), "weapon.warstaff");
  assert.equal(tradeCategoryOf({ itemClass: "Staves" }), "weapon.staff");
  // There is no `armour.body`.
  assert.equal(tradeCategoryOf({ itemClass: "Body Armours" }), "armour.chest");
});

test("a waystone has no category, because its base type is what pins its tier", () => {
  // Absent from the table on purpose rather than by omission: "Waystone (Tier 15)" carries the tier,
  // and widening to a class would price a T15 off T1s.
  assert.equal(tradeCategoryOf({ itemClass: "Waystones" }), null);
});

test("a class the table hasn't got is null, not a guess", () => {
  // A class GGG indexes that this app hasn't captured yet, and a non-English client whose header
  // line matches no key. Both must fall back to the exact-base search.
  assert.equal(tradeCategoryOf({ itemClass: "Bombards" }), null);
  assert.equal(tradeCategoryOf({ itemClass: "Bagues" }), null);
  assert.equal(tradeCategoryOf({ itemClass: "Stackable Currency" }), null);
});

test("no item class at all is null", () => {
  // A client old enough to omit the line entirely — `ParsedItem.itemClass` is null there.
  assert.equal(tradeCategoryOf({ itemClass: null }), null);
});

test("a key inherited from Object.prototype is not a category", () => {
  // The table is a plain object literal, so an item class of "constructor" or "toString" would
  // otherwise resolve to a function rather than to null.
  assert.equal(tradeCategoryOf({ itemClass: "constructor" }), null);
  assert.equal(tradeCategoryOf({ itemClass: "toString" }), null);
});
