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

const WHITE_TWISTED_AMULET = `Item Class: Amulets
Rarity: Normal
Twisted Amulet
--------
Item Level: 79
--------
-1 Prefix Modifier allowed
--------
Allocates Doomsayer
Allocates Blurred Motion`;

const WHITE_TWISTED_AMULET_ADVANCED = `Item Class: Amulets
Rarity: Normal
Distorted Amulet
--------
Item Level: 81
--------
{ Implicit Modifier }
-1 Suffix Modifier allowed
--------
{ Enchant Modifier }
Allocates Doomsayer
{ Enchant Modifier }
Allocates Well of Power`;

test("a white instilled amulet keeps its notables, which are the only thing it is worth", () => {
  // The stated exception to "Normal-rarity items carry no priced affixes". Without it the two
  // `Allocates` lines never exist as mods and the amulet is priced on its item level alone, which
  // is a fact about the base rather than about the item.
  const item = parseItemText(WHITE_TWISTED_AMULET);
  assert.ok(item);
  assert.equal(item?.rarity, "Normal");
  assert.equal(item?.baseType, "Twisted Amulet");
  assert.deepEqual(item?.explicitMods, ["Allocates Doomsayer", "Allocates Blurred Motion"]);
});

test("a white instilled amulet keeps nothing but its notables", () => {
  // The reason Normal was excluded in the first place is still true, so the exception is filtered by
  // shape rather than by trusting the parse: the base's own "-1 Prefix Modifier allowed" implicit is
  // a real line and still must not become a filter, because every listing the category search
  // returns already carries it.
  const item = parseItemText(WHITE_TWISTED_AMULET);
  assert.deepEqual(item?.implicitMods, []);
  assert.equal(
    item?.mods.some((mod) => mod.text.includes("Prefix Modifier allowed")),
    false
  );
});

test("the notables survive Advanced Item Descriptions, which marks them as enchants", () => {
  const item = parseItemText(WHITE_TWISTED_AMULET_ADVANCED);
  assert.deepEqual(
    item?.mods.map((mod) => [mod.text, mod.kind]),
    [
      ["Allocates Doomsayer", "enchant"],
      ["Allocates Well of Power", "enchant"]
    ]
  );
});

test("an ordinary white base still parses to no mods at all", () => {
  // The exception is exactly one shape wide. A waystone's flavour text, a currency's description and
  // every other white item go on producing nothing, which is what kept them out of the row editor.
  assert.deepEqual(parseItemText(WAYSTONE)?.explicitMods, []);
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

/** Mixed tiers under one item, which is what the drop ladder actually has to rank. */
const MIXED_TIER_RING = [
  "Item Class: Rings",
  "Rarity: Rare",
  "Doom Circle",
  "Sapphire Ring",
  "--------",
  "Item Level: 78",
  "--------",
  "{ Implicit Modifier }",
  "+20% to Cold Resistance",
  "--------",
  '{ Prefix Modifier "Sanguine" (Tier: 1) — Life }',
  "+109(100-119) to maximum Life",
  '{ Suffix Modifier "of the Lost" (Tier: 5) — Elemental, Fire, Resistance }',
  "+11(9-13)% to Fire Resistance",
  '{ Suffix Modifier "of the Dank" (Tier: 3) — Elemental, Lightning, Resistance }',
  "+24(23-27)% to Lightning Resistance"
].join("\n");

test("the affix tier is read out of the header", () => {
  const byText = new Map(parseItemText(MIXED_TIER_RING)!.mods.map((mod) => [mod.text, mod.tier]));

  // 1 is the best roll and larger numbers are worse — the order droppableFilters ranks by.
  assert.equal(byText.get("+109 to maximum Life"), 1);
  assert.equal(byText.get("+11% to Fire Resistance"), 5);
  assert.equal(byText.get("+24% to Lightning Resistance"), 3);
});

test("every line under one header shares that header's tier", () => {
  // A hybrid affix is one roll printed as two mod lines. They leave a search together, so they must
  // rank together — reading the tier per line rather than per header would leave the second one
  // unknown and therefore permanently undroppable.
  const byText = new Map(
    parseItemText(ADVANCED_BODY_ARMOUR)!.mods.map((mod) => [mod.text, mod.tier])
  );

  assert.equal(byText.get("+144 to Evasion Rating"), 1);
  assert.equal(byText.get("+47 to maximum Energy Shield"), 1);
});

test("a header with no (Tier: N) leaves the tier null rather than guessing one", () => {
  // PoE2 prints the tier only under Advanced Item Descriptions, so this is the ordinary case for
  // most players and must read as "unknown" — which droppableFilters refuses to drop.
  const item = parseItemText(ADVANCED_GLOVES)!;

  assert.deepEqual([...new Set(item.mods.map((mod) => mod.tier))], [null]);
});

test("clipboard text with no advanced headers at all carries no tiers", () => {
  const item = parseItemText(RARE_GAUNTLETS)!;

  assert.ok(item.mods.length > 0);
  assert.deepEqual([...new Set(item.mods.map((mod) => mod.tier))], [null]);
});

test("the implicit under a tierless header stays tierless next to tiered affixes", () => {
  // The header resets per header, not per section: an untiered implicit block above tiered prefixes
  // must not inherit the tier of a header that comes later.
  const byText = new Map(parseItemText(MIXED_TIER_RING)!.mods.map((mod) => [mod.text, mod.tier]));

  assert.equal(byText.get("+20% to Cold Resistance"), null);
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
  assert.deepEqual(parseItemText(CHAOS_ORB)!.weapon, {
    elementalDamage: null,
    attacksPerSecond: null
  });
});

test("a weapon's damage lines are read, and stay out of the mod list", () => {
  // Same argument as the defence totals one line up: PROPERTY_LINE already keeps these out of the
  // mods, and their product is the elemental DPS GGG indexes as `equipment_filters.edps`.
  // Verbatim shape of a real listing: a Bolting Quarterstaff returned by a live `edps >= 300`
  // search, printing two elemental ranges at 1.54 attacks per second.
  const staff = parseItemText(
    "Item Class: Quarterstaves\nRarity: Rare\nBrood Song\nBolting Quarterstaff\n--------\n" +
      "Physical Damage: 29-117\nElemental Damage: 45-69 (augmented), 17-370 (augmented)\n" +
      "Critical Hit Chance: 10.00%\nAttacks per Second: 1.54 (augmented)\n--------\n" +
      "Item Level: 79\n--------\nAdds 45 to 69 Fire Damage\n+80 to maximum Life"
  )!;

  // 57 + 193.5: a weapon can roll two elements, and taking only the first range would understate
  // this one by three quarters. The `(augmented)` suffix sits after the digits, as everywhere else.
  assert.deepEqual(staff.weapon, { elementalDamage: 250.5, attacksPerSecond: 1.54 });
  assert.deepEqual(staff.mods.map((mod) => mod.text), [
    "Adds 45 to 69 Fire Damage",
    "+80 to maximum Life"
  ]);
});

/**
 * A real capture, verbatim from `loot-cache.json` — the waystone whose six affixes returned 0
 * listings while its reward block describes a market of thousands.
 */
const RARE_WAYSTONE = [
  "Item Class: Waystones",
  "Rarity: Rare",
  "Ghost Frontier",
  "Waystone (Tier 15)",
  "--------",
  "Revives Available: 0 (augmented)",
  "Item Rarity: +24% (augmented)",
  "Pack Size: +7% (augmented)",
  "Monster Rarity: +18% (augmented)",
  "Monster Effectiveness: +13% (augmented)",
  "Waystone Drop Chance: +85% (augmented)",
  "--------",
  "Item Level: 82",
  "--------",
  '{ Prefix Modifier "Infernal" (Tier: 1) }',
  "Monsters deal 19(15-19)% of Damage as Extra Fire",
  '{ Suffix Modifier "of Enduring" (Tier: 1) }',
  "Monsters are Armoured",
  "--------",
  "Can be used in a Map Device, allowing you to enter a Map. Waystones can only be used once."
].join("\n");

test("a waystone's reward totals are read off the property block", () => {
  // These are what `map_filters` indexes, and what a waystone actually trades on — the affixes
  // below produce them collectively, so no single mod maps to any one of them.
  assert.deepEqual(parseItemText(RARE_WAYSTONE)!.mapStats, {
    itemRarity: 24,
    packSize: 7,
    monsterRarity: 18,
    dropChance: 85,
    monsterEffectiveness: 13,
    revives: 0
  });
});

test("the map device usage line is not an affix", () => {
  // It has no colon, so PROPERTY_LINE doesn't skip it, and it doesn't start with "Right click", so
  // the existing guard missed it. It was being stored as an explicit mod on every waystone and
  // offered in the row editor as something to untick.
  const item = parseItemText(RARE_WAYSTONE)!;
  assert.deepEqual(item.explicitMods, [
    "Monsters deal 19% of Damage as Extra Fire",
    "Monsters are Armoured"
  ]);
});

test("an item that isn't a waystone gets all-null map stats rather than throwing", () => {
  assert.deepEqual(parseItemText(CHAOS_ORB)!.mapStats, {
    itemRarity: null,
    packSize: null,
    monsterRarity: null,
    dropChance: null,
    monsterEffectiveness: null,
    revives: null
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
  // and 60% of that group's texts don't exist under `explicit` at all. The tier goes with it — a
  // header that isn't describing this line's kind isn't describing its tier either.
  // `rollRange` is null rather than absent, and unlike the tier it is *not* invalidated by the
  // marker: the bracket is printed by the roll itself, not by the header, so a rune that carried one
  // would keep it. This one prints none.
  assert.deepEqual(rune, [
    {
      text: "18% increased Armour, Evasion and Energy Shield",
      kind: "rune",
      tier: null,
      rollRange: null
    }
  ]);
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

/**
 * The reported capture: a Rare jewel whose trailing usage line was being stored as a fifth explicit
 * mod and offered in the row editor as something to untick.
 */
const ADVANCED_JEWEL = [
  "Item Class: Jewels",
  "Rarity: Rare",
  "Rapture Blood",
  "Ruby",
  "--------",
  "Item Level: 79",
  "--------",
  '{ Prefix Modifier "Rapturous" (Tier: 1) — Damage }',
  "15(14-16)% increased Damage with Plant Skills",
  '{ Prefix Modifier "Plated" (Tier: 1) — Defences }',
  "12(11-13)% increased Armour",
  '{ Suffix Modifier "of Steadiness" (Tier: 1) — Stun }',
  "16(15-17)% increased Stun Threshold",
  '{ Suffix Modifier "of Concussion" (Tier: 1) — Stun, Attack }',
  "15(14-16)% increased Stun Buildup with Maces",
  "--------",
  "Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket."
].join("\n");

/** The same jewel copied without Advanced Item Descriptions, so there are no headers to believe. */
const PLAIN_JEWEL = [
  "Item Class: Jewels",
  "Rarity: Rare",
  "Rapture Blood",
  "Ruby",
  "--------",
  "Item Level: 79",
  "--------",
  "15% increased Damage with Plant Skills",
  "12% increased Armour",
  "16% increased Stun Threshold",
  "15% increased Stun Buildup with Maces",
  "--------",
  "Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket."
].join("\n");

const JEWEL_AFFIXES = [
  "15% increased Damage with Plant Skills",
  "12% increased Armour",
  "16% increased Stun Threshold",
  "15% increased Stun Buildup with Maces"
];

test("a jewel's socket instructions are not an affix", () => {
  // Two sentences, and only the second starts with "Right click", so the click guard missed it —
  // and it carries no colon, so PROPERTY_LINE missed it too.
  const item = parseItemText(ADVANCED_JEWEL)!;

  assert.deepEqual(item.explicitMods, JEWEL_AFFIXES);
  // Where a jewel's jewel-ness actually lives, which is why none of it belongs in the mod list.
  assert.equal(item.itemClass, "Jewels");
});

test("the same jewel without Advanced Item Descriptions loses the line too", () => {
  // No headers anywhere, so the gate never arms and `isKnownNonModLine` is the only thing left. This
  // is what fails if someone deletes the "Place into" entry on the grounds the gate covers it.
  assert.deepEqual(parseItemText(PLAIN_JEWEL)!.explicitMods, JEWEL_AFFIXES);
});

/** A unique's flavour text — prose that no blocklist entry names, which is the point of the gate. */
const ADVANCED_UNIQUE = [
  "Item Class: Rings",
  "Rarity: Unique",
  "Sign of the Sin Eater",
  "Sapphire Ring",
  "--------",
  "Item Level: 80",
  "--------",
  "{ Implicit Modifier }",
  "+20% to Cold Resistance",
  "--------",
  '{ Prefix Modifier "Sanguine" (Tier: 1) — Life }',
  "+109(100-119) to maximum Life",
  "--------",
  "The winter that never ended taught them to burn what they loved."
].join("\n");

test("once an item names its affixes, a headerless section is prose whatever it says", () => {
  // The gate needs no entry per wording, which is the reason it replaced growing the blocklist one
  // item class at a time. Nothing in `isKnownNonModLine` mentions this line.
  const item = parseItemText(ADVANCED_UNIQUE)!;

  assert.deepEqual(item.explicitMods, ["+109 to maximum Life"]);
  assert.deepEqual(item.implicitMods, ["+20% to Cold Resistance"]);
});

test("an unheaded rune line survives the gate, because its suffix names its kind", () => {
  // A rune prints no "{ ... Modifier }" header of its own — it sits in its own section above them and
  // says "(rune)" instead — so the suffix escape is the only thing keeping it once the gate is armed.
  // Delete that escape and every runeforged item silently loses its rune.
  const item = parseItemText(ADVANCED_GLOVES)!;

  assert.deepEqual(
    item.mods.filter((mod) => mod.kind === "rune").map((mod) => mod.text),
    ["18% increased Armour, Evasion and Energy Shield"]
  );
});
