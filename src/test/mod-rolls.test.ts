import assert from "node:assert/strict";
import { test } from "node:test";
import { MOD_ROLL_FLOOR_RATIO, searchFloor, searchFloorsByMod } from "../shared/mod-rolls";
import { parseItemText } from "../parser/item-text-parser";
import type { ParsedItem } from "../shared/types";

function jewel(...lines: string[]): ParsedItem {
  const item = parseItemText(
    "Item Class: Jewels\nRarity: Rare\nPlague Wound\nSapphire\n--------\nItem Level: 80\n--------\n" +
      lines.join("\n")
  );
  assert.ok(item);
  return item!;
}

test("the floor sits halfway between the bracket's minimum and the item's roll", () => {
  // The real Sapphire this came from: at these rolls the search returned 0 listings, at these floors
  // 12 — against the 13 the player found by drawing the same windows by hand.
  assert.equal(searchFloor(12, { min: 7, max: 13 }), 9);
  assert.equal(searchFloor(22, { min: 15, max: 25 }), 18);
  assert.equal(searchFloor(4, { min: 2, max: 4 }), 3);
  assert.equal(searchFloor(9, { min: 8, max: 12 }), 8);
});

test("a max roll still asks for more than a minimum roll of the same affix", () => {
  // The whole reason for halving rather than flooring at the bracket minimum: these two rolls are the
  // same tier, and the better one has to keep being the better one.
  const range = { min: 6, max: 16 };
  assert.ok(searchFloor(16, range) > searchFloor(6, range));
  // And a roll at the bottom of its bracket asks for exactly itself — there is nothing below it.
  assert.equal(searchFloor(6, range), 6);
});

test("the floor is rounded down, never up past a roll GGG indexes as a whole number", () => {
  assert.equal(searchFloor(13, { min: 8, max: 20 }), 10); // 8 + 2.5
  assert.equal(MOD_ROLL_FLOOR_RATIO, 0.5);
});

test("an unknown bracket floors at the roll, which is what every search did before", () => {
  // The no-Advanced-Item-Descriptions case, and every item stored before the bracket was parsed.
  assert.equal(searchFloor(42, null), 42);
  assert.equal(searchFloor(42, undefined), 42);
});

test("a bracket that doesn't sit below the roll is ignored rather than trusted", () => {
  // Not something the game prints, but reading one would ask for an item *better* than this one on
  // that stat — the exact failure this function exists to remove.
  assert.equal(searchFloor(10, { min: 10, max: 20 }), 10);
  assert.equal(searchFloor(10, { min: 12, max: 20 }), 10);
});

test("the parser keeps the bracket the stripped text throws away", () => {
  const item = jewel(
    '{ Prefix Modifier "Chaotic" (Tier: 1) — Damage, Chaos }',
    "12(7-13)% increased Chaos Damage",
    '{ Suffix Modifier "of Enchanting" (Tier: 1) — Caster, Speed }',
    "4(2-4)% increased Cast Speed"
  );

  assert.deepEqual(item.mods, [
    {
      text: "12% increased Chaos Damage",
      kind: "explicit",
      tier: 1,
      rollRange: { min: 7, max: 13 }
    },
    { text: "4% increased Cast Speed", kind: "explicit", tier: 1, rollRange: { min: 2, max: 4 } }
  ]);
});

test("the bracket taken is the first one, because that is the number searched", () => {
  // GGG's templates carry a bare `#` and the matcher reads its first capture, so a two-number line is
  // filtered on the first — and it is the first number's bracket that says how good that roll is.
  const item = jewel(
    '{ Prefix Modifier "Flaring" (Tier: 2) — Damage, Physical }',
    "Adds 12(10-14) to 25(20-30) Physical Damage"
  );

  assert.deepEqual(item.mods[0]!.rollRange, { min: 10, max: 14 });
  assert.equal(item.mods[0]!.text, "Adds 12 to 25 Physical Damage");
});

test("a mod printed without a bracket reports null, not a guess", () => {
  const item = jewel("+80 to maximum Life");
  assert.equal(item.mods[0]!.rollRange, null);
});

test("searchFloorsByMod keys by the same display text the editor and ignore list use", () => {
  const item = jewel(
    '{ Prefix Modifier "Chaotic" (Tier: 1) — Damage, Chaos }',
    "12(7-13)% increased Chaos Damage",
    "Cannot be Frozen"
  );

  // The second line carries no number at all, so there is no floor to offer — and the editor renders
  // no bound boxes for it either.
  assert.deepEqual(searchFloorsByMod(item.mods), [{ text: "12% increased Chaos Damage", min: 9 }]);
});
