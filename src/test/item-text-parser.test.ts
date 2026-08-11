import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItemText } from "../parser/item-text-parser";

const CHAOS_ORB = `Rarity: Currency
Chaos Orb
--------
Stack Size: 4/10
--------
Reforges a rare item with new random modifiers
--------
Right click this item then left click a rare item to apply it.`;

const RARE_GAUNTLETS = `Rarity: Rare
Doom Grip
Titan Gauntlets
--------
Item Level: 82
--------
Quality: +20% (augmented)
Armour: 250
--------
Requires Level: 68, Str 100
--------
+15 to Strength (implicit)
--------
+80 to maximum Life
+45% to Fire Resistance
Adds 5 to 10 Physical Damage to Attacks
--------
Corrupted`;

const UNIQUE_KAOMS_HEART = `Rarity: Unique
Kaom's Heart
Glorious Plate
--------
Item Level: 84
--------
Quality: +20% (augmented)
Armour: 1656
--------
Requires Level: 68, Str 152
--------
+40% to Fire Resistance
+374 to maximum Life
Socketed Gems are Supported by Level 20 Fire Penetration`;

const WAYSTONE = `Rarity: Normal
Waystone (Tier 5)
--------
Item Level: 68
--------
Waystone Drop Chance: +50% (augmented)
--------
Right click to add this to your map device.`;

const UNIDENTIFIED_RARE = `Rarity: Rare
Doom Grip
Titan Gauntlets
--------
Item Level: 82
--------
Unidentified`;

const MAGIC_WAYSTONE = `Item Class: Waystones
Rarity: Magic
Chilled Waystone of Exposure
--------
Waystone Tier: 14
Waystone Drop Chance: +25% (augmented)
--------
Item Level: 79
--------
Monsters are Chilled
Monsters have 25% reduced Elemental Resistances
--------
Right click to add this to your map device.`;

const UNCUT_SKILL_GEM = `Item Class: Skill Gems
Rarity: Currency
Uncut Skill Gem
--------
Level: 18
--------
Item Level: 18
--------
Right click to view all Skill Gems you can create.`;

const SKILL_GEM = `Item Class: Skill Gems
Rarity: Gem
Fireball
--------
Fire, Projectile, Spell, AoE
Level: 20
Quality: +20% (augmented)
Cost: 20 Mana
--------
Requires Level: 70, 111 Int
--------
Deals 100 to 150 Fire Damage`;

const SOCKETED_RARE = `Item Class: Gloves
Rarity: Rare
Doom Grip
Titan Gauntlets
--------
Quality: +12% (augmented)
Armour: 250
--------
Requires Level: 68, Str 100
--------
Sockets: S S
--------
Item Level: 82
--------
Grants Skill: Level 20 Fireball
+80 to maximum Life
+45% to Fire Resistance`;

const CURRENCY_LARGE_STACK = `Item Class: Stackable Currency
Rarity: Currency
Exalted Orb
--------
Stack Size: 1,234/5,000
--------
Right click this item then left click an item to apply it.`;

test("parses a stacked currency item", () => {
  const item = parseItemText(CHAOS_ORB);
  assert.ok(item);
  assert.equal(item?.rarity, "Currency");
  assert.equal(item?.name, "Chaos Orb");
  assert.equal(item?.baseType, "Chaos Orb");
  assert.equal(item?.stackSize, 4);
  assert.equal(item?.identified, true);
  assert.equal(item?.corrupted, false);
  assert.deepEqual(item?.explicitMods, []);
});

test("parses a corrupted rare item with implicit and explicit mods", () => {
  const item = parseItemText(RARE_GAUNTLETS);
  assert.ok(item);
  assert.equal(item?.rarity, "Rare");
  assert.equal(item?.name, "Doom Grip");
  assert.equal(item?.baseType, "Titan Gauntlets");
  assert.equal(item?.corrupted, true);
  assert.deepEqual(item?.implicitMods, ["+15 to Strength"]);
  assert.deepEqual(item?.explicitMods, [
    "+80 to maximum Life",
    "+45% to Fire Resistance",
    "Adds 5 to 10 Physical Damage to Attacks"
  ]);
});

test("parses a unique item", () => {
  const item = parseItemText(UNIQUE_KAOMS_HEART);
  assert.ok(item);
  assert.equal(item?.rarity, "Unique");
  assert.equal(item?.name, "Kaom's Heart");
  assert.equal(item?.baseType, "Glorious Plate");
  assert.equal(item?.corrupted, false);
  assert.deepEqual(item?.explicitMods, [
    "+40% to Fire Resistance",
    "+374 to maximum Life",
    "Socketed Gems are Supported by Level 20 Fire Penetration"
  ]);
});

test("parses a normal-rarity waystone without treating flavor text as mods", () => {
  const item = parseItemText(WAYSTONE);
  assert.ok(item);
  assert.equal(item?.rarity, "Normal");
  assert.equal(item?.name, "Waystone (Tier 5)");
  assert.equal(item?.baseType, "Waystone (Tier 5)");
  assert.deepEqual(item?.explicitMods, []);
});

test("flags unidentified items", () => {
  const item = parseItemText(UNIDENTIFIED_RARE);
  assert.ok(item);
  assert.equal(item?.identified, false);
});

test("returns null for empty input", () => {
  assert.equal(parseItemText(""), null);
});

test("captures the item class, which is the only reliable category signal", () => {
  assert.equal(parseItemText(MAGIC_WAYSTONE)?.itemClass, "Waystones");
  assert.equal(parseItemText(UNCUT_SKILL_GEM)?.itemClass, "Skill Gems");
  assert.equal(parseItemText(CURRENCY_LARGE_STACK)?.itemClass, "Stackable Currency");
  // Older clipboard text has no Item Class line at all.
  assert.equal(parseItemText(CHAOS_ORB)?.itemClass, null);
});

test("parses a magic waystone's tier and mods", () => {
  const item = parseItemText(MAGIC_WAYSTONE);
  assert.ok(item);
  assert.equal(item?.rarity, "Magic");
  assert.equal(item?.waystoneTier, 14);
  assert.equal(item?.itemLevel, 79);
  // The usage line sits in its own section and must not be read as an affix.
  assert.deepEqual(item?.explicitMods, [
    "Monsters are Chilled",
    "Monsters have 25% reduced Elemental Resistances"
  ]);
});

test("an uncut skill gem keeps its level, which is what it is priced on", () => {
  const item = parseItemText(UNCUT_SKILL_GEM);
  assert.ok(item);
  assert.equal(item?.gemLevel, 18);
  assert.equal(item?.itemLevel, 18);
});

test("a gem's own Level is not confused with Item Level or Requires Level", () => {
  const item = parseItemText(SKILL_GEM);
  assert.ok(item);
  assert.equal(item?.gemLevel, 20);
  assert.equal(item?.quality, 20);
  assert.equal(item?.itemLevel, null, "this gem has no Item Level line");
});

test("quality and sockets are captured, and a property line no longer eats the affix block", () => {
  const item = parseItemText(SOCKETED_RARE);
  assert.ok(item);
  assert.equal(item?.quality, 12);
  assert.equal(item?.socketCount, 2);
  // "Grants Skill:" shares the section with real affixes; it used to discard all three lines.
  assert.deepEqual(item?.explicitMods, ["+80 to maximum Life", "+45% to Fire Resistance"]);
});

test("a stack size printed with thousands separators is read as a number", () => {
  assert.equal(parseItemText(CURRENCY_LARGE_STACK)?.stackSize, 1234);
});

test("items without the new properties report null rather than a placeholder", () => {
  const item = parseItemText(CHAOS_ORB);
  assert.ok(item);
  assert.equal(item?.quality, null);
  assert.equal(item?.gemLevel, null);
  assert.equal(item?.waystoneTier, null);
  assert.equal(item?.socketCount, null);
  assert.equal(item?.itemLevel, null);
});

/**
 * Real clipboard captures from a player running with **Advanced Item Descriptions** enabled — the
 * game option that adds "{ Prefix Modifier ... }" grouping headers and splices the roll range into
 * the number itself. Before these were handled, this glove parsed to 18 "explicit mods" of which 7
 * were brace headers and one was "Unmodifiable", zero implicits were found, and exactly 1 of the 8
 * real mods could be matched to a GGG stat id — so every rare fell back to a base-type-only search.
 */
const ADVANCED_GLOVES = [
  "Item Class: Gloves",
  "Rarity: Rare",
  "Demon Claw",
  "Fists of Stone",
  "--------",
  "Evasion Rating: 336 (augmented)",
  "Energy Shield: 112 (augmented)",
  "--------",
  "Sockets: S ",
  "--------",
  "Item Level: 81",
  "--------",
  "18% increased Armour, Evasion and Energy Shield (rune)",
  "--------",
  "{ Implicit Modifier }",
  "Has +3 to Evasion Rating per player level",
  "Has +1 to maximum Energy Shield per player level",
  "--------",
  '{ Prefix Modifier "Polar" — Elemental, Cold, Attack }',
  "Attacks Gain 20(19-20)% of Damage as Extra Cold Damage",
  '{ Suffix Modifier "of Fury" — Critical }',
  "+2.33(2.1-2.5)% to Critical Hit Chance",
  '{ Suffix Modifier "of the Ice" — Elemental, Cold, Resistance }',
  "+2% to Maximum Cold Resistance",
  "+36(36-40)% to Cold Resistance",
  "--------",
  "Unmodifiable"
].join("\n");

/** Same format, but with "(Tier: N)" in the headers and several lines under one modifier. */
const ADVANCED_BODY_ARMOUR = [
  "Item Class: Body Armours",
  "Rarity: Rare",
  "Ghoul Hide",
  "Runeforged Falconer's Jacket",
  "--------",
  "Quality: +20% (augmented)",
  "Evasion Rating: 1301 (augmented)",
  "Runic Ward: 227 (augmented)",
  "--------",
  "Requires: Level 75, 67 Dex, 67 Int",
  "--------",
  "Sockets: S S ",
  "--------",
  "Item Level: 81",
  "--------",
  "36% increased Armour, Evasion and Energy Shield (rune)",
  "--------",
  "{ Implicit Modifier — Speed }",
  "5% increased Movement Speed",
  "--------",
  "{ Prefix Modifier \"Banshee's\" (Tier: 1) — Evasion, Energy Shield }",
  "+144(142-161) to Evasion Rating",
  "+47(43-48) to maximum Energy Shield",
  '{ Suffix Modifier "of the Phoenix" (Tier: 1) — Life }',
  "34.9(33.1-36) Life Regeneration per second"
].join("\n");

test("advanced-description brace headers are not mistaken for mods", () => {
  const item = parseItemText(ADVANCED_GLOVES);
  assert.ok(item);
  assert.equal(
    item!.mods.some((mod) => mod.text.startsWith("{")),
    false,
    "grouping headers must never reach the mod list"
  );
  assert.equal(item!.explicitMods.includes("Unmodifiable"), false);
});

test("inline roll ranges are stripped, leaving the number a stat template can match", () => {
  const item = parseItemText(ADVANCED_GLOVES);
  const texts = item!.mods.map((mod) => mod.text);

  // GGG's templates carry a bare "#", and the matcher anchors end to end, so "20(19-20)%" matches
  // nothing at all. This single line is why mod-aware search was silently doing nothing.
  assert.ok(texts.includes("Attacks Gain 20% of Damage as Extra Cold Damage"), texts.join(" | "));
  assert.ok(texts.includes("+2.33% to Critical Hit Chance"), texts.join(" | "));
  assert.ok(texts.includes("+36% to Cold Resistance"), texts.join(" | "));
});

test("a decimal roll range with no leading sign is stripped too", () => {
  const texts = parseItemText(ADVANCED_BODY_ARMOUR)!.mods.map((mod) => mod.text);

  assert.ok(texts.includes("34.9 Life Regeneration per second"), texts.join(" | "));
  assert.ok(texts.includes("+144 to Evasion Rating"), texts.join(" | "));
});

test("a { Implicit Modifier } header classifies the lines beneath it", () => {
  const item = parseItemText(ADVANCED_GLOVES);

  assert.deepEqual(item!.implicitMods, [
    "Has +3 to Evasion Rating per player level",
    "Has +1 to maximum Energy Shield per player level"
  ]);
});

test("the defence totals are read out of the property block", () => {
  // These lines match PROPERTY_LINE and are skipped by mod parsing, so they used to be discarded
  // entirely. They are what GGG's equipment_filters index, and the game has already folded every
  // local mod and the item's quality into them.
  assert.deepEqual(parseItemText(RARE_GAUNTLETS)!.defences, {
    armour: 250,
    evasion: null,
    energyShield: null,
    ward: null
  });
  // Four digits, printed without a thousands separator.
  assert.equal(parseItemText(UNIQUE_KAOMS_HEART)!.defences.armour, 1656);
});

test("an (augmented) suffix and a hybrid base don't confuse the defence lines", () => {
  // The suffix is what the game appends once any mod contributes, and it sits after the digits.
  assert.deepEqual(parseItemText(ADVANCED_GLOVES)!.defences, {
    armour: null,
    evasion: 336,
    energyShield: 112,
    ward: null
  });
  // Runeforged bases print "Runic Ward:" where others print "Energy Shield:" — a distinct
  // equipment_filters id (`ward`), not a synonym.
  assert.deepEqual(parseItemText(ADVANCED_BODY_ARMOUR)!.defences, {
    armour: null,
    evasion: 1301,
    energyShield: null,
    ward: 227
  });
});

test("an item with no property block gets all-null defences rather than throwing", () => {
  assert.deepEqual(parseItemText(CHAOS_ORB)!.defences, {
    armour: null,
    evasion: null,
    energyShield: null,
    ward: null
  });
});

test("a header's kind stops at the section break, so prefixes aren't read as implicit", () => {
  const item = parseItemText(ADVANCED_BODY_ARMOUR);

  assert.deepEqual(item!.implicitMods, ["5% increased Movement Speed"]);
  assert.ok(item!.explicitMods.includes("+144 to Evasion Rating"));
});

test("a (rune) line keeps its own kind rather than inheriting the enclosing header", () => {
  const item = parseItemText(ADVANCED_GLOVES);
  const rune = item!.mods.filter((mod) => mod.kind === "rune");

  // The trailing marker has to win: the stat id for a rune-granted mod lives in GGG's `rune` group,
  // and 60% of that group's texts don't exist under `explicit` at all.
  assert.deepEqual(rune, [{ text: "18% increased Armour, Evasion and Energy Shield", kind: "rune" }]);
});

test("prefixes and suffixes are both plain explicit affixes", () => {
  const item = parseItemText(ADVANCED_GLOVES);
  const kinds = new Set(item!.mods.map((mod) => mod.kind));

  assert.deepEqual([...kinds].sort(), ["explicit", "implicit", "rune"]);
});

test("the flattened arrays stay consistent with mods, since the store and UI read them", () => {
  for (const raw of [ADVANCED_GLOVES, ADVANCED_BODY_ARMOUR]) {
    const item = parseItemText(raw)!;
    assert.deepEqual(
      item.implicitMods,
      item.mods.filter((mod) => mod.kind === "implicit").map((mod) => mod.text)
    );
    assert.deepEqual(
      item.explicitMods,
      item.mods.filter((mod) => mod.kind !== "implicit").map((mod) => mod.text)
    );
  }
});
