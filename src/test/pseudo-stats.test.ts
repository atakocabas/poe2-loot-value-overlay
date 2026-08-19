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

test("a lone contributor is not aggregated into a combined total", () => {
  // "Total elemental resistance >= 38" would match an item whose 38 is all cold. Looser without
  // being any more accurate about what this item is.
  assert.equal(byId(ring("+38% to Fire Resistance"), "pseudo.pseudo_total_elemental_resistance"), undefined);
  assert.deepEqual(derivePseudoStats(ring("+80 to maximum Life")), []);
});

// ---------------------------------------------------------------------------
// The combined elemental total versus the three single-element ones
// ---------------------------------------------------------------------------

const FIRE = "pseudo.pseudo_total_fire_resistance";
const COLD = "pseudo.pseudo_total_cold_resistance";
const LIGHTNING = "pseudo.pseudo_total_lightning_resistance";
const ELEMENTAL = "pseudo.pseudo_total_elemental_resistance";

test("one element's rolls aggregate as that element, at any number of them", () => {
  // The exception to the two-contributor rule, and it is exact rather than approximate: "total fire
  // resistance >= 38" is precisely what this mod says. It is also strictly wider than the explicit
  // filter, because it counts a listing that reaches 38 through an all-elemental roll — measured live
  // on `Sapphire Ring`, explicit fire >= 42 returned 9290 listings and the pseudo 10000+.
  assert.equal(pseudoTotal(byId(ring("+38% to Fire Resistance"), FIRE)!), 38);

  const twoRolls = ring("+30% to Fire Resistance", "+28% to Fire Resistance");
  assert.equal(pseudoTotal(byId(twoRolls, FIRE)!), 58);
  // And never both views: the combined total says less about this item than the fire one does.
  assert.equal(byId(twoRolls, ELEMENTAL), undefined);
});

test("two different elements go back to the combined total", () => {
  const item = ring("+30% to Fire Resistance", "+25% to Cold Resistance");

  assert.equal(pseudoTotal(byId(item, ELEMENTAL)!), 55);
  for (const id of [FIRE, COLD, LIGHTNING]) assert.equal(byId(item, id), undefined);
});

test("an all-elemental roll counts as every element, so it hands back to the combined total", () => {
  // It would be a lie to price this as a fire item: it really does carry 15% cold and lightning too.
  const item = ring("+30% to Fire Resistance", "+15% to all Elemental Resistances");

  assert.equal(pseudoTotal(byId(item, ELEMENTAL)!), 75);
  assert.equal(byId(item, FIRE), undefined);
});

test("a lone all-elemental roll aggregates nothing, and keeps its own stat filter", () => {
  // Three per-element filters derived from one mod would lengthen the ladder to say exactly what
  // that mod's own explicit stat already says.
  assert.deepEqual(derivePseudoStats(ring("+15% to all Elemental Resistances")), []);
});

test("each aggregate reports the contributor count it needs, for the row editor to mirror", () => {
  // The renderer is a plain <script> and cannot import this module, so the rule travels as a number
  // rather than as a second copy of itself. See PseudoStat.minContributors.
  assert.equal(byId(ring("+38% to Fire Resistance"), FIRE)!.minContributors, 1);
  assert.equal(
    byId(ring("+80 to maximum Life", "+45 to maximum Life"), "pseudo.pseudo_total_life")!.minContributors,
    2
  );
});

test("the contributing affixes' tiers ride along for the editor to badge", () => {
  const tiered = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n--------\n" +
      "{ Prefix Modifier \"Sanguine\" (Tier: 1) — Life }\n+80 to maximum Life\n" +
      "{ Suffix Modifier \"of the Walrus\" (Tier: 4) — Life }\n+45 to maximum Life"
  );

  assert.deepEqual(
    byId(tiered, "pseudo.pseudo_total_life")!.contributors.map((c) => c.tier),
    [1, 4]
  );
  // An item captured without Advanced Item Descriptions has none at all, which is the ordinary case
  // and must read as "unknown" rather than as a tier.
  assert.deepEqual(
    byId(ring("+80 to maximum Life", "+45 to maximum Life"), "pseudo.pseudo_total_life")!.contributors.map(
      (c) => c.tier
    ),
    [null, null]
  );
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
