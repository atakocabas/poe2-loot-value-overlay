import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { PricedItem } from "../shared/types";

/**
 * `suggestSellRange` turns the listings a trade2 price was sampled over into what to *ask* for the
 * item — or into a refusal, which on the stored rows is the more common answer. Like `listedAgeEl` it
 * lives in `src/renderer/common.ts`, which the renderer loads as a plain `<script>` and which
 * therefore exports nothing; see `item-groups.test.ts` for why the compiled file is run in a `vm` and
 * the function read off that context's global rather than moved to `shared/`.
 *
 * Only `getElementById` is stubbed here: unlike the row builders this is pure arithmetic over the
 * item, and common.js touches the DOM once at top level to find `#item-tooltip`.
 */
type SellSuggestion =
  | { kind: "dead"; ageMs: number }
  | { kind: "stale"; ageMs: number }
  | { kind: "range"; low: number; high: number; used: number; trimmed: number }
  | { kind: "single"; value: number; used: number; flat: boolean }
  | { kind: "needsReprice" };

type SuggestSellRange = (item: PricedItem, count: number, now?: number) => SellSuggestion | null;
type ListingQuote = { amount: number; currency: string };
type SellSuggestionText = (
  suggestion: SellSuggestion,
  quote?: ListingQuote | null
) => { text: string; title: string; warn: boolean };

function loadSellRange(): {
  suggest: SuggestSellRange;
  describe: SellSuggestionText;
  setRates: (chaosPerDivine: number, exaltedPerDivine: number) => void;
} {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "common.js"), "utf-8");
  const context = vm.createContext({
    document: {
      getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      createElement: () => ({ className: "", textContent: "", title: "", dataset: {} })
    }
  });
  vm.runInContext(source, context);

  const scope = context as { suggestSellRange?: SuggestSellRange; sellSuggestionText?: SellSuggestionText };
  assert.ok(scope.suggestSellRange, "common.js no longer exposes suggestSellRange on the script global");
  assert.ok(scope.sellSuggestionText, "common.js no longer exposes sellSuggestionText on the script global");
  return {
    suggest: scope.suggestSellRange,
    describe: scope.sellSuggestionText,
    // `rates` is a module-level `let` the panel fills in from OVERLAY_STATUS; unit choice is dead
    // code until it has one, and the straddling bug below only exists once it does.
    setRates: (chaosPerDivine, exaltedPerDivine) =>
      vm.runInContext(
        `rates = { chaosPerDivine: ${chaosPerDivine}, exaltedPerDivine: ${exaltedPerDivine} };`,
        context
      )
  };
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

/** A trade2-priced rare. `tradeListingIndexedAt` is the cheapest listing, which is what the gate reads. */
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
    tradeListingIndexedAt: NOW - HOUR,
    ...overrides
  };
}

/**
 * A verdict copied into this realm.
 *
 * Objects built inside the `vm` context carry that context's `Object.prototype`, which
 * `deepStrictEqual` counts as a difference — two structurally identical verdicts fail to compare,
 * with a diff that shows them as equal. Copying the fields out is what makes the assertion about them.
 */
function plain(value: SellSuggestion | null): SellSuggestion | null {
  return value === null ? null : ({ ...value } as SellSuggestion);
}

/** `n` listings at one price, all posted `ageH` hours before NOW. */
function listings(chaos: number[], ageH: number): Array<{ chaos: number; indexedAt?: number }> {
  return chaos.map((value) => ({ chaos: value, indexedAt: NOW - ageH * HOUR }));
}

describe("suggestSellRange", () => {
  const { suggest } = loadSellRange();

  describe("the dominance gate", () => {
    test("a cheapest listing two months old is a dead market, with no sample needed", () => {
      // The case that matters most: every row stored before the sample was retained is this shape,
      // and the verdict is still the useful one.
      const item = makeItem({ tradeListingIndexedAt: NOW - 72 * DAY });
      assert.deepEqual(plain(suggest(item, 1, NOW)), { kind: "dead", ageMs: 72 * DAY });
    });

    test("fresh listings priced above a month-old cheapest one do not revive it", () => {
      // The whole point of the gate. Five listings posted an hour ago look like an active market
      // until you notice that the cheapest offer on the board has sat unsold for forty days — so
      // nothing above it has sold either, and a weighted average would happily invent a range here.
      const item = makeItem({
        tradeListingIndexedAt: NOW - 40 * DAY,
        tradeListingSample: [{ chaos: 1, indexedAt: NOW - 40 * DAY }, ...listings([9, 10, 11, 12], 1)]
      });
      assert.deepEqual(plain(suggest(item, 1, NOW)), { kind: "dead", ageMs: 40 * DAY });
    });

    test("the verdict flips either side of thirty days", () => {
      const alive = makeItem({ tradeListingIndexedAt: NOW - 29 * DAY });
      const dead = makeItem({ tradeListingIndexedAt: NOW - 31 * DAY });
      assert.equal(suggest(alive, 1, NOW)?.kind, "needsReprice");
      assert.equal(suggest(dead, 1, NOW)?.kind, "dead");
    });
  });

  describe("without a retained sample", () => {
    test("a row inside the gate asks to be repriced rather than guessing", () => {
      assert.deepEqual(plain(suggest(makeItem(), 1, NOW)), { kind: "needsReprice" });
    });

    test("an empty sample is treated as no sample, not as no listings", () => {
      // Distinct failures: "nothing was kept" is a storage fact about this row, while "nothing
      // matched" is a fact about the market and never reaches here — an unpriced row has no value.
      const item = makeItem({ tradeListingSample: [] });
      assert.deepEqual(plain(suggest(item, 1, NOW)), { kind: "needsReprice" });
    });
  });

  describe("the range", () => {
    test("the low end is the cheapest live listing and the high end sits at or above it", () => {
      const item = makeItem({ tradeListingSample: listings([10, 12, 14, 18, 20], 1) });
      const suggestion = suggest(item, 1, NOW);
      assert.equal(suggestion?.kind, "range");
      assert.equal(suggestion.low, 10);
      assert.ok(suggestion.high > suggestion.low, "a spread of prices should produce a spread");
      assert.equal(suggestion.used, 5);
      assert.equal(suggestion.trimmed, 0);
    });

    test("a listing priced far under the rest of its own sample is discarded", () => {
      // The measured case: on the stored rows the cheapest listing sat below a sixth of its own
      // sample median often enough to matter, worst case 364x. Undercutting a price-fixer is how you
      // sell an 11-chaos item for three hundredths of one.
      const item = makeItem({ tradeListingSample: listings([0.03, 11, 11, 11, 11], 1) });
      const suggestion = suggest(item, 1, NOW);
      assert.equal(suggestion?.kind, "single");
      assert.equal(suggestion.value, 11);
      assert.equal(suggestion.used, 4);
    });

    test("the trim is refused when it would leave too little to reason over", () => {
      // Two survivors is not a market: on a sample this thin the outlier may simply be the price.
      const item = makeItem({ tradeListingSample: listings([1, 100, 100], 1) });
      const suggestion = suggest(item, 1, NOW);
      assert.equal(suggestion?.kind, "range");
      assert.equal(suggestion.low, 1, "the cheap listing should have survived the refused trim");
      assert.equal(suggestion.trimmed, 0);
    });

    test("a flat cheap end collapses to one number and says so", () => {
      const item = makeItem({ tradeListingSample: listings([5, 5, 5, 5, 5], 1) });
      const suggestion = suggest(item, 1, NOW);
      assert.equal(suggestion?.kind, "single");
      assert.deepEqual(
        { value: suggestion.value, flat: suggestion.flat, used: suggestion.used },
        { value: 5, flat: true, used: 5 }
      );
    });

    test("aging the dearer listings pulls the high end down", () => {
      // The same five prices twice, differing only in how long four of them have sat. Weight moving
      // off the listings nobody bought is the entire mechanism, and this is what it looks like from
      // outside: the low end is the same live listing, the high end is not.
      const fresh = makeItem({ tradeListingSample: listings([10, 12, 14, 18, 20], 1) });
      const older = makeItem({
        tradeListingSample: [...listings([10], 1), ...listings([12, 14, 18, 20], 40)]
      });
      const a = suggest(fresh, 1, NOW);
      const b = suggest(older, 1, NOW);
      assert.equal(a?.kind, "range");
      assert.equal(b?.kind, "range");
      assert.equal(a.low, b.low, "the cheapest live listing is the same one in both");
      assert.ok(b.high < a.high, `aged sample should ask less, got ${b.high} against ${a.high}`);
    });

    test("past two days a listing stops counting as live at all", () => {
      // The half-life is a day and the liveness floor is a quarter, so the cutoff lands at about 48h.
      // Below it the dearer listings still weigh something; above it only the fresh one is evidence,
      // and a range built from one observation is a single number honestly labelled.
      const item = makeItem({
        tradeListingSample: [...listings([10], 1), ...listings([12, 14, 18, 20], 60)]
      });
      const suggestion = suggest(item, 1, NOW);
      assert.equal(suggestion?.kind, "single");
      assert.equal(suggestion.value, 10, "only the fresh listing is still evidence of a price");
    });

    test("listings GGG sent no date for still count, at a reduced weight", () => {
      // Absence of a date is not evidence of staleness. The gate already ran on the cheapest
      // listing's own date, which is stored separately and required, so this cannot smuggle a dead
      // market past it.
      const item = makeItem({
        tradeListingSample: [{ chaos: 10 }, { chaos: 12 }, { chaos: 14 }, { chaos: 18 }]
      });
      assert.equal(suggest(item, 1, NOW)?.kind, "range");
    });
  });

  describe("the stale verdict", () => {
    test("inside the gate but with nothing live in it, there is no sell price", () => {
      const item = makeItem({
        tradeListingIndexedAt: NOW - 5 * DAY,
        tradeListingSample: listings([10, 12, 14, 18], 5 * 24)
      });
      assert.deepEqual(plain(suggest(item, 1, NOW)), { kind: "stale", ageMs: 5 * DAY });
    });
  });

  describe("the guards, which are listedAgeEl's", () => {
    test("a manual price replaces the trade figure, so the listings describe nothing on screen", () => {
      const item = makeItem({ manualChaosValue: 42, tradeListingSample: listings([10, 12, 14], 1) });
      assert.equal(suggest(item, 1, NOW), null);
    });

    test("no other price source has listings behind it", () => {
      assert.equal(suggest(makeItem({ priceSource: "poeninja" }), 1, NOW), null);
    });

    test("an unpriced row has no headline for a suggestion to qualify", () => {
      const item = makeItem({ chaosValue: null, priceSource: "unpriced" });
      assert.equal(suggest(item, 1, NOW), null);
    });

    test("a folded group total is a sum, and one listing is not a fact about a sum", () => {
      assert.equal(suggest(makeItem({ tradeListingSample: listings([10], 1) }), 2, NOW), null);
    });

    test("a stack is a sum for the same reason", () => {
      const item = makeItem({ stackSize: 20, tradeListingSample: listings([10], 1) });
      assert.equal(suggest(item, 1, NOW), null);
    });

    test("an item with no listing date has no age for the gate to read", () => {
      const item = makeItem({ tradeListingIndexedAt: undefined, tradeListingSample: listings([10], 1) });
      assert.equal(suggest(item, 1, NOW), null);
    });
  });
});

describe("sellSuggestionText", () => {
  const { describe: label } = loadSellRange();

  test("a dead market reads as a warning and names the age", () => {
    const { text, warn } = label({ kind: "dead", ageMs: 72 * DAY });
    assert.ok(warn, "a dead market is the thing worth noticing in the editor");
    assert.match(text, /72d/);
  });

  test("a stale sample warns too, and is worded apart from a dead one", () => {
    const dead = label({ kind: "dead", ageMs: 40 * DAY });
    const stale = label({ kind: "stale", ageMs: 5 * DAY });
    assert.ok(stale.warn);
    assert.notEqual(dead.text, stale.text);
  });

  test("a range prints both ends and reports what it was drawn from", () => {
    const { text, title, warn } = label({ kind: "range", low: 10, high: 20, used: 5, trimmed: 1 });
    assert.equal(warn, false);
    assert.match(text, /^Ask .+ - .+$/);
    assert.match(title, /5 sampled listing/);
    assert.match(title, /discarding 1/);
  });

  test("a range that discarded nothing does not say so", () => {
    const { title } = label({ kind: "range", low: 10, high: 20, used: 5, trimmed: 0 });
    assert.doesNotMatch(title, /discarding/);
  });

  test("a flat sample is described as settled rather than as a lone observation", () => {
    const flat = label({ kind: "single", value: 5, used: 5, flat: true });
    const lone = label({ kind: "single", value: 5, used: 1, flat: false });
    assert.match(flat.title, /settled/);
    assert.match(lone.title, /single/);
  });

  test("both ends of a range are printed in one unit", () => {
    // A regression, and it was live: `formatValue` picks a unit per value from its magnitude, so a
    // range crossing the divine boundary printed as "10c - 1.26div" — two units on one line, which
    // the reader has to convert before the span means anything.
    const { describe: withRates, setRates } = loadSellRange();
    setRates(11.08, 360);
    const { text } = withRates({ kind: "range", low: 10, high: 14, used: 5, trimmed: 0 });
    // Only what trails a number: the leading verb is not a unit.
    const units = text.match(/(?<=[0-9])[a-z]+/g) ?? [];
    assert.equal(units.length, 2, `expected two unit labels in ${text}`);
    assert.equal(units[0], units[1], `both ends should read in one unit, got ${text}`);
  });

  test("the range follows the unit the row headline is drawn in", () => {
    // The suggestion sits directly under the headline; the two reading in different units would look
    // like a discrepancy rather than a choice.
    const { describe: withRates, setRates } = loadSellRange();
    setRates(11.08, 360);
    const asChaos = withRates(
      { kind: "range", low: 10, high: 14, used: 5, trimmed: 0 },
      { amount: 10, currency: "chaos" }
    );
    assert.match(asChaos.text, /c - .*c$/, asChaos.text);
  });

  test("a row with no retained sample is told what to do about it", () => {
    assert.match(label({ kind: "needsReprice" }).text, /Reprice/);
  });
});
