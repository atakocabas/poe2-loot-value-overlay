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
 * **Every total is a floor.** A buyer choosing between waystones wants at least this much rarity,
 * pack size, monster rarity and drop chance, and revives is the same — more attempts is a benefit.
 * Monster Effectiveness is the one that has moved, twice: excluded outright at first (a floor would
 * exclude the easier waystones, which are worth *more*), then sent as a ceiling (the comparables are
 * the maps at *most* this dangerous), and now a floor like the other five. That last step is a
 * preference about which waystones to price against rather than a measurement — the ceiling worked,
 * it just isn't what's wanted. Don't "restore" it without asking.
 *
 * `map_tier` stays absent, for a different reason that has not changed — the base type is per-tier,
 * and measured live, `type: "Waystone (Tier 15)"` plus `map_tier: { min: 16 }` returns zero listings,
 * so the tier is already exact without it. `map_gold` and `map_experience` are published too but
 * nothing parses them; they are not printed on the clipboard's property block.
 */
const MAP_FILTERS: Array<{ key: keyof ItemMapStats; id: string; label: string }> = [
  { key: "itemRarity", id: "map_iir", label: "Item Rarity" },
  { key: "packSize", id: "map_packsize", label: "Pack Size" },
  { key: "monsterRarity", id: "map_rare_monsters", label: "Monster Rarity" },
  { key: "dropChance", id: "map_bonus", label: "Waystone Drop Chance" },
  { key: "revives", id: "map_revives", label: "Revives Available" },
  { key: "monsterEffectiveness", id: "map_magic_monsters", label: "Monster Effectiveness" }
];

/**
 * A waystone's searchable totals. Empty for anything that isn't one, and for a waystone whose property
 * block was never parsed — both mean "no constraint", which is the pre-feature query.
 *
 * **A total of 0 is culled, whichever stat it is.** A floor of 0 asks for nothing every listing
 * doesn't already satisfy, so it only spends query surface — that is what keeps a waystone printing
 * `Revives Available: 0` from carrying a dead filter. The rule is uniform now that Monster
 * Effectiveness is a floor too: a `+0%` waystone is simply searched on its rewards.
 *
 * Shared by the client that builds the filters and the editor that shows the rows, so the two can't
 * drift on which totals are searched or what they're called.
 */
export function mapRowsOf(item: Pick<ParsedItem, "itemClass" | "mapStats">): MapRow[] {
  if (!isWaystone(item)) return [];

  const stats = mapStatsOf(item);
  return MAP_FILTERS.filter(({ key }) => {
    const value = stats[key];
    return value !== null && value > 0;
  }).map(({ key, id, label }) => ({ id, label, value: stats[key]! }));
}

/** Display name for a `map_filters` id, for the log lines and no-match messages. */
export function mapFilterLabel(id: string): string {
  return MAP_FILTERS.find((filter) => filter.id === id)?.label ?? id;
}
