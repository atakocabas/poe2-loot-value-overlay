import type { ParsedItem } from "./types";

/**
 * `Item Class:` → GGG's `type_filters.filters.category` option, for searching a rare on its **class**
 * rather than on its exact base type.
 *
 * A rare's worth lives in its mods, its defences and its implicits, not in which of a class's bases
 * carries them — and pinning the base is what starved the search on an illiquid one. Widening to the
 * class is what `Trade2Client` sends instead; see `docs/pricing-trade2.md` for the two measured
 * captures that motivated it and for the three rules that keep the wider search honest.
 *
 * The option ids are **confirmed against `/api/trade2/data/filters`**, in the `type_filters` group's
 * `category` filter, not inferred from the class names. Two that do not read the way they look:
 *
 * - **`weapon.warstaff` is Quarterstaff.** `weapon.staff` is the separate Staff class, and swapping
 *   the two searches an entirely different weapon.
 * - **`armour.chest` is Body Armour.** There is no `armour.body`.
 *
 * Left out on purpose, though GGG publishes them: `weapon.onemelee` (an "Any One-Handed Melee"
 * bucket, not a class, so it would widen past the item), `weapon.talisman`, `weapon.rod`,
 * `weapon.unarmed`, and the flask/charm entries. Waystones are absent for a stronger reason — see
 * `tradeCategoryOf()`.
 *
 * The keys are the plural nouns PoE2 prints. Those confirmed against real captures in `src/test/`
 * are Rings, Amulets, Body Armours, Gloves, Foci, Quarterstaves and Jewels; the rest follow the same
 * convention and are the row to suspect first if a class silently keeps searching by base type.
 */
const TRADE_CATEGORIES: Record<string, string> = {
  // Accessories
  Rings: "accessory.ring",
  Amulets: "accessory.amulet",
  Belts: "accessory.belt",

  // Armour
  Helmets: "armour.helmet",
  "Body Armours": "armour.chest",
  Gloves: "armour.gloves",
  Boots: "armour.boots",
  Shields: "armour.shield",
  Foci: "armour.focus",
  Bucklers: "armour.buckler",
  Quivers: "armour.quiver",

  // Weapons
  Wands: "weapon.wand",
  Sceptres: "weapon.sceptre",
  Staves: "weapon.staff",
  Quarterstaves: "weapon.warstaff",
  Bows: "weapon.bow",
  Crossbows: "weapon.crossbow",
  Daggers: "weapon.dagger",
  Claws: "weapon.claw",
  Spears: "weapon.spear",
  Flails: "weapon.flail",
  "One Hand Swords": "weapon.onesword",
  "One Hand Axes": "weapon.oneaxe",
  "One Hand Maces": "weapon.onemace",
  "Two Hand Swords": "weapon.twosword",
  "Two Hand Axes": "weapon.twoaxe",
  "Two Hand Maces": "weapon.twomace",

  // Jewels
  Jewels: "jewel"
};

/**
 * The category to search this item's class on, or null to keep searching its exact base type.
 *
 * Keyed off `itemClass` for the same reason `isWaystone()` is: it is the only reliable category
 * signal in the clipboard text. `rarity` is "Rare" for a ring exactly as it is for a waystone, and
 * `baseType` is the thing being replaced.
 *
 * **Null is a working answer, not a failure.** It means "search as this app always did", and three
 * real cases reach it: a class GGG indexes that this table hasn't got yet, a non-English client whose
 * header line won't match any key, and `itemClass === null` on a client old enough to omit the line
 * entirely. Each of those degrades to the exact-base search rather than to a search with no type
 * constraint at all — which would be every rare in the league.
 *
 * **Waystones are deliberately absent from the table.** Their base type is per-tier ("Waystone (Tier
 * 15)") and so pins the tier, which is the whole reason `map_tier` is never sent. Widening a waystone
 * to a class would drop the tier from the query and price a T15 off T1s.
 */
export function tradeCategoryOf(item: Pick<ParsedItem, "itemClass">): string | null {
  const itemClass = item.itemClass;
  if (itemClass === null || itemClass === undefined) return null;
  // Own keys only. The table is an object literal, so a bare index would answer `"constructor"` and
  // `"toString"` with something off `Object.prototype` — a function, which is not a category and
  // would be sent to GGG as one.
  if (!Object.prototype.hasOwnProperty.call(TRADE_CATEGORIES, itemClass)) return null;
  return TRADE_CATEGORIES[itemClass] ?? null;
}
