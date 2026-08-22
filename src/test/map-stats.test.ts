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

test("every printed total is a floor, difficulty included", () => {
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

  // Monster Effectiveness was a ceiling once, on the argument that difficulty is a cost to the
  // buyer. It is a floor like the other five now — a chosen preference about which waystones to
  // price against, so there is no direction to carry on the row at all.
  assert.deepEqual(
    rows.map((row) => [row.id, row.value]),
    [
      ["map_iir", 24],
      ["map_packsize", 7],
      ["map_rare_monsters", 18],
      ["map_bonus", 85],
      ["map_revives", 6],
      ["map_magic_monsters", 13]
    ]
  );
});

test("a total of zero is culled, whichever stat it is", () => {
  // A floor of 0 asks for nothing every listing does not already satisfy, so it only spends query
  // surface. Uniform now: the ceiling that used to make Monster Effectiveness the exception is gone.
  assert.deepEqual(mapRowsOf(waystone({ itemRarity: 0, revives: 0, monsterEffectiveness: 0 })), []);
});

test("a stat the game never printed produces no row at all", () => {
  // null is "not printed" and 0 is "printed as zero". Neither yields a row, but for the reason
  // above they are still worth telling apart — a parser that returned 0 for an absent line would
  // read as a real total the moment any of these becomes something other than a floor.
  assert.deepEqual(mapRowsOf(waystone({ monsterEffectiveness: null, itemRarity: 24 })), [
    { id: "map_iir", label: "Item Rarity", value: 24 }
  ]);
});

test("filter ids have display names, and an unknown one falls back to itself", () => {
  // These are GGG's own ids, confirmed against /api/trade2/data/filters ("Endgame Filters").
  assert.equal(mapFilterLabel("map_magic_monsters"), "Monster Effectiveness");
  assert.equal(mapFilterLabel("map_iir"), "Item Rarity");
  assert.equal(mapFilterLabel("map_gold"), "map_gold");
});
