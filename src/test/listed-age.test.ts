import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { PricedItem } from "../shared/types";

/**
 * `listedAgeEl` builds the `(listed 3d ago)` that sits beside a trade2 price. Like `groupItems` it
 * lives in `src/renderer/common.ts`, which the renderer loads as a plain `<script>` and which
 * therefore exports nothing — see `item-groups.test.ts` for why the compiled file is run in a `vm`
 * and the function read off that context's global rather than moved to `shared/`.
 *
 * Three stubs: `getElementById`, because common.js reads `#item-tooltip` at top level;
 * `createElement`, because this function is the one that builds a node; and `dataset` on that node,
 * which the element writes so `refreshElapsedLabels` can re-read it every tick.
 */
interface StubEl {
  className: string;
  textContent: string;
  title: string;
  dataset: Record<string, string>;
}

type ListedAgeEl = (item: PricedItem, count: number, total: number | null) => StubEl | null;

function loadListedAgeEl(): ListedAgeEl {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "common.js"), "utf-8");
  const context = vm.createContext({
    document: {
      getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      createElement: (): StubEl => ({ className: "", textContent: "", title: "", dataset: {} })
    }
  });
  vm.runInContext(source, context);

  const fn = (context as { listedAgeEl?: ListedAgeEl }).listedAgeEl;
  assert.ok(fn, "common.js no longer exposes listedAgeEl on the script global");
  return fn;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** A trade2-priced rare whose cheapest listing went up three days ago. */
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
    tradeListingIndexedAt: Date.now() - 3 * DAY,
    ...overrides
  };
}

describe("listedAgeEl", () => {
  test("prints how old the cheapest listing is, labelled to say what it is", () => {
    const el = loadListedAgeEl()(makeItem(), 1, 10);

    assert.ok(el);
    assert.equal(el.textContent, "(listed 3d ago)");
    assert.equal(el.className, "item-value-listed");
    // The word is what separates it from the capture time on the line below, which is a bare
    // "14s ago". Two unlabelled relative times on one row read as the same clock.
    assert.match(el.textContent, /listed/);
    assert.match(el.title, /cheapest listing/);
  });

  test("carries the timestamp so the label can age with the clock", () => {
    // `refreshElapsedLabels` re-reads `data-at` every 30s and rewrites the text. Without it the
    // label would freeze at whatever it said when the row was drawn and quietly go stale.
    const at = Date.now() - 5 * DAY;
    const el = loadListedAgeEl()(makeItem({ tradeListingIndexedAt: at }), 1, 10);

    assert.ok(el);
    assert.equal(el.dataset.at, String(at));
  });

  test("a listing older than a day reads in days, not in dozens of hours", () => {
    // The reason `relativeTime` grew a day tier: listings are routinely days old, and "72h ago" is
    // a number the reader has to divide before it means anything.
    const el = loadListedAgeEl()(makeItem({ tradeListingIndexedAt: Date.now() - 3 * DAY }), 1, 10);

    assert.ok(el);
    assert.match(el.textContent, /\dd ago/);
    assert.doesNotMatch(el.textContent, /h ago/);
  });

  test("a listing from this morning still reads in hours", () => {
    const el = loadListedAgeEl()(makeItem({ tradeListingIndexedAt: Date.now() - 5 * HOUR }), 1, 10);

    assert.ok(el);
    assert.equal(el.textContent, "(listed 5h ago)");
  });

  test("says nothing when the price came from anywhere but trade2", () => {
    // No other source has a listing behind it for the date to be the age of.
    const item = makeItem({ priceSource: "poeninja" });
    assert.equal(loadListedAgeEl()(item, 1, 10), null);
  });

  test("a manual price drops it, since it no longer annotates the number on screen", () => {
    const item = makeItem({ manualChaosValue: 25 });
    assert.equal(loadListedAgeEl()(item, 1, 25), null);
  });

  test("an item priced before the field existed simply has no parenthetical", () => {
    // Nothing migrates loot-cache.json, so this is the ordinary state of every stored rare on the
    // first launch after the change. It is also what a listing GGG sent no date for produces, and
    // both must render nothing rather than "(listed ?)".
    const item = makeItem({ tradeListingIndexedAt: undefined });
    assert.equal(loadListedAgeEl()(item, 1, 10), null);
  });

  test("a folded group drops it, because the headline there is a sum", () => {
    assert.equal(loadListedAgeEl()(makeItem(), 3, 30), null);
  });

  test("an unpriced row has no headline to qualify", () => {
    const item = makeItem({ chaosValue: null, priceSource: "unpriced" });
    assert.equal(loadListedAgeEl()(item, 1, null), null);
  });
});
