import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePseudoStats, pseudoTotal } from "../shared/pseudo-stats";
import { parseItemText } from "../parser/item-text-parser";
import type { ParsedItem } from "../shared/types";

function parse(rawText: string): ParsedItem {
  const item = parseItemText(rawText);
  assert.ok(item);
  return item!;
}

/** A ring — no property block, so no displayed defences and nothing suppressed. */
function ring(...mods: string[]): ParsedItem {
  return parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      `--------\n${mods.join("\n")}`
  );
}

const byId = (item: ParsedItem, id: string) => derivePseudoStats(item).find((s) => s.id === id);

test("three resistance rolls become one elemental total", () => {
  const item = ring("+38% to Cold Resistance", "+25% to Fire Resistance", "+20% to Lightning Resistance");
  const stat = byId(item, "pseudo.pseudo_total_elemental_resistance");

  // The whole point: the market prices 83% total, not three pinned rolls nobody else has.
  assert.ok(stat);
  assert.equal(pseudoTotal(stat!), 83);
  assert.equal(stat!.contributors.length, 3);
});

test("'to all Elemental Resistances' counts three times, not once", () => {
  const item = ring("+15% to all Elemental Resistances", "+20% to Fire Resistance");
  const stat = byId(item, "pseudo.pseudo_total_elemental_resistance");

  // 15 to each of three elements is 45 toward the total. Counting it once understates a very common
  // mod by two thirds and prices the item off far weaker comparables.
  assert.equal(pseudoTotal(stat!), 65);
});

test("chaos resistance is its own aggregate and stays out of the elemental one", () => {
  const item = ring(
    "+38% to Cold Resistance",
    "+25% to Fire Resistance",
    "+17% to Chaos Resistance",
    "+11% to Chaos Resistance"
  );

  assert.equal(pseudoTotal(byId(item, "pseudo.pseudo_total_elemental_resistance")!), 63);
  assert.equal(pseudoTotal(byId(item, "pseudo.pseudo_total_chaos_resistance")!), 28);
});

test("a lone contributor is not aggregated", () => {
  // "Total elemental resistance >= 38" would match an item whose 38 is all cold. Looser without
  // being any more accurate about what this item is.
  assert.equal(byId(ring("+38% to Fire Resistance"), "pseudo.pseudo_total_elemental_resistance"), undefined);
  assert.deepEqual(derivePseudoStats(ring("+80 to maximum Life")), []);
});

test("energy shield aggregates on a ring but not on a body armour that displays it", () => {
  const onARing = ring("+40 to maximum Energy Shield", "+35 to maximum Energy Shield");
  assert.equal(pseudoTotal(byId(onARing, "pseudo.pseudo_total_energy_shield")!), 75);

  // Identical mod text, but here it is local: it is already inside the `Energy Shield:` total that
  // equipment_filters searches, and isLocalDefenceMod has already stripped it from the stat filters.
  // Deriving a pseudo too would ask for the same energy shield twice.
  const onArmour = parse(
    "Item Class: Body Armours\nRarity: Rare\nGhoul Hide\nFalconer's Jacket\n--------\n" +
      "Energy Shield: 120\n--------\nItem Level: 81\n--------\n" +
      "+40 to maximum Energy Shield\n+35 to maximum Energy Shield"
  );
  assert.equal(byId(onArmour, "pseudo.pseudo_total_energy_shield"), undefined);
});

test("attributes sum across the three, and 'all Attributes' counts three times", () => {
  const item = ring("+15 to Strength", "+12 to Dexterity", "+10 to all Attributes");
  assert.equal(pseudoTotal(byId(item, "pseudo.pseudo_total_attributes")!), 57);
});

test("conditional and unrelated mods are not folded into an aggregate", () => {
  // Anchored patterns, not "any line mentioning Fire Resistance" — these are stats GGG indexes
  // separately, and folding them away would search them with nothing.
  const item = ring(
    "+38% to Cold Resistance",
    "+25% to Fire Resistance",
    "Regenerate 3% of maximum Life per second",
    "25% reduced Fire Resistance while affected by Herald of Ash",
    "+10 to maximum Life per Level"
  );

  assert.equal(pseudoTotal(byId(item, "pseudo.pseudo_total_elemental_resistance")!), 63);
  assert.equal(byId(item, "pseudo.pseudo_total_life"), undefined);
});

test("an item with nothing aggregatable derives nothing", () => {
  assert.deepEqual(derivePseudoStats(ring("Cannot be Frozen", "20% increased Rarity of Items found")), []);
});

test("derivation works on an item persisted before ParsedItem.mods existed", () => {
  // Same trap as everywhere else: nothing migrates loot-cache.json, so this must go through modsOf
  // and defencesOf rather than reading the fields.
  const legacy = {
    implicitMods: ["+18% to Fire Resistance"],
    explicitMods: ["+25% to Cold Resistance"]
  } as unknown as ParsedItem;

  assert.equal(pseudoTotal(derivePseudoStats(legacy)[0]!), 43);
});
