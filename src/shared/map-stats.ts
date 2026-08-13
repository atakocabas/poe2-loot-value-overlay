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
 * The reward totals worth searching on, keyed to GGG's `map_filters` ids — confirmed against
 * `/api/trade2/data/filters`, where the group is titled "Endgame Filters".
 *
 * Only the four rewards. `map_magic_monsters` (Monster Effectiveness) and `map_revives` are published
 * and parsed but deliberately absent: they describe difficulty, which is a cost to the buyer rather
 * than a benefit, so a `min` floor on them would exclude the easier waystones that are worth *more*.
 * `map_tier` is absent for a different reason — the base type is per-tier, and measured live,
 * `type: "Waystone (Tier 15)"` plus `map_tier: { min: 16 }` returns zero listings, so the tier is
 * already exact without it.
 */
const MAP_FILTERS: Array<{ key: keyof ItemMapStats; id: string; label: string }> = [
  { key: "itemRarity", id: "map_iir", label: "Item Rarity" },
  { key: "packSize", id: "map_packsize", label: "Pack Size" },
  { key: "monsterRarity", id: "map_rare_monsters", label: "Monster Rarity" },
  { key: "dropChance", id: "map_bonus", label: "Waystone Drop Chance" }
];

/**
 * A waystone's searchable reward totals. Empty for anything that isn't one, and for a waystone whose
 * property block was never parsed — both mean "no reward constraint", which is the pre-feature query.
 *
 * Shared by the client that builds the filters and the editor that shows the rows, so the two can't
 * drift on which totals are searched or what they're called.
 */
export function mapRowsOf(item: Pick<ParsedItem, "itemClass" | "mapStats">): MapRow[] {
  if (!isWaystone(item)) return [];

  const stats = mapStatsOf(item);
  return MAP_FILTERS.filter(({ key }) => stats[key] !== null && stats[key]! > 0).map(
    ({ key, id, label }) => ({ id, label, value: stats[key]! })
  );
}

/** Display name for a `map_filters` id, for the log lines and no-match messages. */
export function mapFilterLabel(id: string): string {
  return MAP_FILTERS.find((filter) => filter.id === id)?.label ?? id;
}
