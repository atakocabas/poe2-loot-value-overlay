import type { ItemMapStats, MapRow, ParsedItem } from "./types";

const NO_MAP_STATS: ItemMapStats = {
  itemRarity: null,
  packSize: null,
  monsterRarity: null,
  dropChance: null,
  monsterEffectiveness: null,
  revives: null
};

/**
 * A waystone's printed reward totals, or all-null for one captured before they were parsed.
 *
 * Same reason `defencesOf()` and `modsOf()` exist: `loot-cache.json` is read back as-is with no
 * migration, so an older waystone has no `mapStats` key and reading `item.mapStats.itemRarity`
 * throws. All-null is the correct fallback — it means "no reward constraint", which is exactly how
 * this app searched before, so an old waystone simply gets the old query.
 */
export function mapStatsOf(item: Pick<ParsedItem, "mapStats">): ItemMapStats {
  return item.mapStats ?? NO_MAP_STATS;
}

/**
 * Whether this item is a waystone, and so should be searched on the block above rather than on its
 * affixes.
 *
 * Keyed off `itemClass` because it is the only reliable category signal in the clipboard text —
 * `rarity` is "Rare" for a waystone exactly as it is for a ring, and `baseType` is per-tier
 * ("Waystone (Tier 15)"), so neither can be tested against a fixed string.
 */
export function isWaystone(item: Pick<ParsedItem, "itemClass">): boolean {
  return item.itemClass === "Waystones";
}

/**
 * The printed totals worth searching on, keyed to GGG's `map_filters` ids — confirmed against
 * `/api/trade2/data/filters`, where the group is titled "Endgame Filters".
 *
 * **The direction is the whole design here.** Every reward is a floor: a buyer choosing between
 * waystones wants at least this much rarity, pack size, drop chance. Revives is a floor for the same
 * reason — more attempts is a benefit. Monster Effectiveness is the one that inverts, and it used to
 * be excluded outright on the grounds that "a `min` floor would exclude the easier waystones that are
 * worth more". That reasoning was right about the direction and wrong about the remedy: difficulty is
 * a cost to the buyer, so the comparables are the waystones at **most** this dangerous, which is a
 * ceiling rather than an absence. Sending nothing priced a 5% waystone against 50% ones.
 *
 * `map_tier` stays absent, for a different reason that has not changed — the base type is per-tier,
 * and measured live, `type: "Waystone (Tier 15)"` plus `map_tier: { min: 16 }` returns zero listings,
 * so the tier is already exact without it. `map_gold` and `map_experience` are published too but
 * nothing parses them; they are not printed on the clipboard's property block.
 */
const MAP_FILTERS: Array<{
  key: keyof ItemMapStats;
  id: string;
  label: string;
  direction: "min" | "max";
}> = [
  { key: "itemRarity", id: "map_iir", label: "Item Rarity", direction: "min" },
  { key: "packSize", id: "map_packsize", label: "Pack Size", direction: "min" },
  { key: "monsterRarity", id: "map_rare_monsters", label: "Monster Rarity", direction: "min" },
  { key: "dropChance", id: "map_bonus", label: "Waystone Drop Chance", direction: "min" },
  { key: "revives", id: "map_revives", label: "Revives Available", direction: "min" },
  {
    key: "monsterEffectiveness",
    id: "map_magic_monsters",
    label: "Monster Effectiveness",
    direction: "max"
  }
];

/**
 * A waystone's searchable totals. Empty for anything that isn't one, and for a waystone whose property
 * block was never parsed — both mean "no constraint", which is the pre-feature query.
 *
 * **The zero test is direction-aware, and that asymmetry is deliberate.** A floor of 0 asks for
 * nothing and is culled, which is what keeps a waystone printing `Revives Available: 0` from carrying
 * a filter every listing already satisfies. A *ceiling* of 0 is the opposite: it is the best possible
 * case, the one worth the most, and culling it would drop the constraint on exactly the waystones this
 * exists to price.
 *
 * Shared by the client that builds the filters and the editor that shows the rows, so the two can't
 * drift on which totals are searched, what they're called, or which way they point.
 */
export function mapRowsOf(item: Pick<ParsedItem, "itemClass" | "mapStats">): MapRow[] {
  if (!isWaystone(item)) return [];

  const stats = mapStatsOf(item);
  return MAP_FILTERS.filter(({ key, direction }) => {
    const value = stats[key];
    return value !== null && (direction === "max" || value > 0);
  }).map(({ key, id, label, direction }) => ({ id, label, value: stats[key]!, direction }));
}

/** Display name for a `map_filters` id, for the log lines and no-match messages. */
export function mapFilterLabel(id: string): string {
  return MAP_FILTERS.find((filter) => filter.id === id)?.label ?? id;
}
