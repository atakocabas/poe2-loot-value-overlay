import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { PricedItem } from "../shared/types";

/**
 * `groupItems` lives in `src/renderer/common.ts`, which the renderer loads as a plain `<script>` and
 * which therefore exports nothing — there is no `import` to write. Rather than leave it untested or
 * keep a second copy in `shared/` that would drift, the compiled file is run as a script in a `vm`
 * context and the function is read off that context's global, which is exactly how the page gets it.
 *
 * The one stub is `document`: common.js reads `#item-tooltip` at top level. Nothing below touches the
 * tooltip, so a shape that survives `getElementById` is enough.
 */
interface ItemGroup {
  item: PricedItem;
  count: number;
  total: number | null;
}

function loadGroupItems(): (items: PricedItem[]) => ItemGroup[] {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "common.js"), "utf-8");
  const context = vm.createContext({
    document: { getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }) }
  });
  vm.runInContext(source, context);

  const groupItems = (context as { groupItems?: (items: PricedItem[]) => ItemGroup[] }).groupItems;
  assert.ok(groupItems, "common.js no longer exposes groupItems on the script global");
  return groupItems;
}

function makeItem(overrides: Partial<PricedItem> = {}): PricedItem {
  return {
    rawText: "",
    rarity: "Currency",
    name: "Omen of Chaotic Effectiveness",
    baseType: "Omen of Chaotic Effectiveness",
    itemClass: "Stackable Currency",
    stackSize: 1,
    itemLevel: null,
    quality: null,
    gemLevel: null,
    waystoneTier: null,
    socketCount: null,
    defences: { armour: null, evasion: null, energyShield: null, ward: null },
    weapon: { elementalDamage: null, attacksPerSecond: null },
    mapStats: {
      itemRarity: null,
      packSize: null,
      monsterRarity: null,
      dropChance: null,
      monsterEffectiveness: null,
      revives: null
    },
    identified: true,
    corrupted: false,
    mods: [],
    implicitMods: [],
    explicitMods: [],
    capturedAt: 0,
    id: "id-0",
    chaosValue: 10,
    priceSource: "poeninja",
    ignoredMods: [],
    manualChaosValue: null,
    ...overrides
  };
}

describe("groupItems", () => {
  test("a folded group is dated from its newest pickup, not its first", () => {
    // The real capture that found this: an Omen picked up hours earlier, the same Omen again at
    // 20:24:31, and a unique three seconds before that. The group kept the 16:53 item, so the
    // heads-up form sorted it behind the unique and showed the *older* drop as the last one.
    const groupItems = loadGroupItems();
    const groups = groupItems([
      makeItem({ id: "old-omen", capturedAt: 1000 }),
      makeItem({ id: "unique", name: "Valako's Vice", rarity: "Unique", capturedAt: 3000 }),
      makeItem({ id: "new-omen", capturedAt: 4000 })
    ]);

    const omens = groups.find((group) => group.item.name === "Omen of Chaotic Effectiveness");
    assert.ok(omens);
    assert.equal(omens.item.id, "new-omen");
    // What `minimalGroups()` sorts on, and what the row prints as "Ns ago".
    assert.equal(omens.item.capturedAt, 4000);
    // The newest is the representative, but every pickup still counts toward the row.
    assert.equal(omens.count, 2);
    assert.equal(omens.total, 20);
  });

  test("capture order isn't assumed — an out-of-order list still keeps the newest", () => {
    const groupItems = loadGroupItems();
    const groups = groupItems([
      makeItem({ id: "newest", capturedAt: 9000 }),
      makeItem({ id: "older", capturedAt: 2000 })
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0].item.id, "newest");
    assert.equal(groups[0].count, 2);
  });

  test("stack sizes and values still add up across a fold", () => {
    const groupItems = loadGroupItems();
    const groups = groupItems([
      makeItem({ id: "a", name: "Exalted Orb", chaosValue: 2, stackSize: 5, capturedAt: 1000 }),
      makeItem({ id: "b", name: "Exalted Orb", chaosValue: 2, stackSize: 3, capturedAt: 2000 })
    ]);

    assert.equal(groups[0].count, 8);
    assert.equal(groups[0].total, 16);
  });

  test("an unpriced pickup makes the whole row unpriced rather than understating it", () => {
    const groupItems = loadGroupItems();
    const groups = groupItems([
      makeItem({ id: "a", capturedAt: 1000 }),
      makeItem({ id: "b", chaosValue: null, capturedAt: 2000 })
    ]);

    assert.equal(groups[0].total, null);
  });

  test("items carrying mods or a manual price are never folded together", () => {
    const groupItems = loadGroupItems();
    const groups = groupItems([
      // Same name and source, but neither is interchangeable with anything.
      makeItem({ id: "a", rarity: "Rare", name: "Empyrean Joy", explicitMods: ["+10 to Strength"] }),
      makeItem({ id: "b", rarity: "Rare", name: "Empyrean Joy", explicitMods: ["+12 to Strength"] }),
      makeItem({ id: "c", manualChaosValue: 5 }),
      makeItem({ id: "d", manualChaosValue: 5 })
    ]);

    assert.equal(groups.length, 4);
  });

  test("the same currency from two price sources stays two rows", () => {
    const groupItems = loadGroupItems();
    const groups = groupItems([
      makeItem({ id: "a", priceSource: "poeninja" }),
      makeItem({ id: "b", priceSource: "currencyExchange" })
    ]);

    assert.equal(groups.length, 2);
  });
});
