import { test } from "node:test";
import assert from "node:assert";
import { isWaystone, mapFilterLabel, mapRowsOf, mapStatsOf } from "../shared/map-stats";
import type { ItemMapStats, ParsedItem } from "../shared/types";

type MapItem = Pick<ParsedItem, "itemClass" | "mapStats">;

function waystone(stats: Partial<ItemMapStats>): MapItem {
  return {
    itemClass: "Waystones",
    mapStats: {
      itemRarity: null,
      packSize: null,
      monsterRarity: null,
      dropChance: null,
      monsterEffectiveness: null,
      revives: null,
      ...stats
    }
  };
}

test("a waystone is identified by item class, not by rarity or base type", () => {
  // "Rare" is the rarity of a ring too, and the base type is per-tier — neither can be tested against
  // a fixed string, which is why `itemClass` is the signal.
  assert.equal(isWaystone({ itemClass: "Waystones" }), true);
  assert.equal(isWaystone({ itemClass: "Rings" }), false);
  assert.equal(isWaystone({ itemClass: null }), false);
});

test("nothing but a waystone yields rows", () => {
  assert.deepEqual(mapRowsOf({ itemClass: "Rings", mapStats: waystone({ itemRarity: 24 }).mapStats }), []);
});

test("a waystone captured before map stats were parsed reads as all-null rather than throwing", () => {
  // Nothing migrates `loot-cache.json`, so an older waystone has no `mapStats` key at all. All-null
  // means "no constraint", which is exactly the query this app sent before the feature existed.
  const stale = { itemClass: "Waystones" } as MapItem;
  assert.equal(mapStatsOf(stale).itemRarity, null);
  assert.deepEqual(mapRowsOf(stale), []);
});

test("rewards and revives are floors, difficulty is a ceiling", () => {
  const rows = mapRowsOf(
    waystone({
      itemRarity: 24,
      packSize: 7,
      monsterRarity: 18,
      dropChance: 85,
      revives: 6,
      monsterEffectiveness: 13
    })
  );

  assert.deepEqual(
    rows.map((row) => [row.id, row.value, row.direction]),
    [
      ["map_iir", 24, "min"],
      ["map_packsize", 7, "min"],
      ["map_rare_monsters", 18, "min"],
      ["map_bonus", 85, "min"],
      ["map_revives", 6, "min"],
      // Difficulty is a cost to the buyer, so the comparables are the maps at most this dangerous.
      ["map_magic_monsters", 13, "max"]
    ]
  );
});

test("a floor of zero is culled but a ceiling of zero is kept", () => {
  // The asymmetry is the point. A floor of 0 asks for nothing; a ceiling of 0 is the best possible
  // waystone, and culling it would drop the constraint on exactly the ones worth the most.
  const rows = mapRowsOf(waystone({ itemRarity: 0, revives: 0, monsterEffectiveness: 0 }));

  assert.deepEqual(rows, [
    { id: "map_magic_monsters", label: "Monster Effectiveness", value: 0, direction: "max" }
  ]);
});

test("a stat the game never printed produces no row at all", () => {
  // null is "not printed" and 0 is "printed as zero" — only the second is a ceiling worth sending.
  assert.deepEqual(mapRowsOf(waystone({ monsterEffectiveness: null, itemRarity: 24 })), [
    { id: "map_iir", label: "Item Rarity", value: 24, direction: "min" }
  ]);
});

test("filter ids have display names, and an unknown one falls back to itself", () => {
  // These are GGG's own ids, confirmed against /api/trade2/data/filters ("Endgame Filters").
  assert.equal(mapFilterLabel("map_magic_monsters"), "Monster Effectiveness");
  assert.equal(mapFilterLabel("map_iir"), "Item Rarity");
  assert.equal(mapFilterLabel("map_gold"), "map_gold");
});
