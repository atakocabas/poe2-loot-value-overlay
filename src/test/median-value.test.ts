import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { PricedItem } from "../shared/types";

/**
 * `medianValueEl` builds the `(18ex)` that sits beside a trade2 price. Like `groupItems` it lives in
 * `src/renderer/common.ts`, which the renderer loads as a plain `<script>` and which therefore
 * exports nothing — see `item-groups.test.ts` for why the compiled file is run in a `vm` and the
 * function read off that context's global rather than moved to `shared/`.
 *
 * Two stubs: `getElementById`, because common.js reads `#item-tooltip` at top level, and
 * `createElement`, because this function is the one that builds a node. The element only has to
 * survive the property writes below.
 *
 * Nothing here sets the module-level `rates`, so `formatValue` takes its no-rates branch and prints
 * plain chaos — which is what makes the expected strings below stable. The point is that the
 * parenthetical goes through the *same* formatter as the headline, so the two can never disagree
 * about units, not what a particular unit looks like.
 */
interface StubEl {
  className: string;
  textContent: string;
  title: string;
}

function loadMedianValueEl(): (item: PricedItem, count: number, total: number | null) => StubEl | null {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "common.js"), "utf-8");
  const context = vm.createContext({
    document: {
      getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      createElement: (): StubEl => ({ className: "", textContent: "", title: "" })
    }
  });
  vm.runInContext(source, context);

  const fn = (context as { medianValueEl?: (item: PricedItem, count: number, total: number | null) => StubEl | null })
    .medianValueEl;
  assert.ok(fn, "common.js no longer exposes medianValueEl on the script global");
  return fn;
}

/** A trade2-priced rare: floor 10 chaos, median of the same sample 40. */
function makeItem(overrides: Partial<PricedItem> = {}): PricedItem {
  return {
    rawText: "",
    rarity: "Rare",
    name: "Ghost Frontier",
    baseType: "Soldier Cuirass",
    itemClass: "Body Armour",
    stackSize: 1,
    itemLevel: 80,
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
    priceSource: "trade2",
    ignoredMods: [],
    manualChaosValue: null,
    tradeMedianChaosValue: 40,
    ...overrides
  };
}

describe("medianValueEl", () => {
  test("prints the median beside a trade2 price, formatted like the headline", () => {
    const medianValueEl = loadMedianValueEl();
    const el = medianValueEl(makeItem(), 1, 10);

    assert.ok(el);
    assert.equal(el.textContent, "(40c)");
    assert.equal(el.className, "item-value-median");
    assert.match(el.title, /cheapest/);
  });

  test("says nothing when the price came from anywhere but trade2", () => {
    const medianValueEl = loadMedianValueEl();
    // No other source samples a set of listings, so there is no median to have.
    const item = makeItem({ priceSource: "poeninja", tradeMedianChaosValue: 40 });
    assert.equal(medianValueEl(item, 1, 10), null);
  });

  test("a manual price drops it, rather than reading as a range the user never set", () => {
    const medianValueEl = loadMedianValueEl();
    const item = makeItem({ manualChaosValue: 25 });
    assert.equal(medianValueEl(item, 1, 25), null);
  });

  test("an item priced before the field existed simply has no parenthetical", () => {
    const medianValueEl = loadMedianValueEl();
    // Nothing migrates loot-cache.json, so this is the ordinary state of every stored rare on the
    // first launch after the change — it must not render "(?)".
    const item = makeItem({ tradeMedianChaosValue: undefined });
    assert.equal(medianValueEl(item, 1, 10), null);
  });

  test("a folded group drops it, because the headline there is a sum", () => {
    const medianValueEl = loadMedianValueEl();
    assert.equal(medianValueEl(makeItem(), 3, 30), null);
  });

  test("a floor equal to its own median is not worth two numbers", () => {
    const medianValueEl = loadMedianValueEl();
    // What a one-listing sample produces. "10c (10c)" is noise, not information.
    const item = makeItem({ tradeMedianChaosValue: 10 });
    assert.equal(medianValueEl(item, 1, 10), null);
  });

  test("an unpriced row has no headline to qualify", () => {
    const medianValueEl = loadMedianValueEl();
    const item = makeItem({ chaosValue: null, priceSource: "unpriced" });
    assert.equal(medianValueEl(item, 1, null), null);
  });
});
