import assert from "node:assert/strict";
import { test } from "node:test";
import { toChaos } from "../pricing/currency-convert";
import type { PoeNinjaClient } from "../pricing/poeninja-client";

/** Real-ish PoE2 numbers: ~7.86 chaos per divine, ~374.7 exalted per divine. */
const RATES = { chaosPerDivine: 7.86, exaltedPerDivine: 374.7 };

function makePoeNinja(
  rates: typeof RATES | null,
  byName: Record<string, number> = {}
): PoeNinjaClient {
  return {
    getRates: () => rates,
    getChaosValue: (name: string) => byName[name] ?? null
  } as unknown as PoeNinjaClient;
}

test("chaos passes through untouched", () => {
  assert.equal(toChaos(makePoeNinja(RATES), 3, "chaos"), 3);
});

test("divine converts off the rates block, not an item lookup", () => {
  // No entry in the name map at all — this must still resolve, since the Currency category may not
  // be among the fetched poe.ninja types.
  assert.equal(toChaos(makePoeNinja(RATES), 2, "divine"), 15.72);
});

test("exalted converts through divine, which is the only rate poe.ninja publishes", () => {
  const value = toChaos(makePoeNinja(RATES), 374.7, "exalted");

  // 374.7 exalted is exactly one divine, so this must land on chaosPerDivine.
  assert.ok(value !== null && Math.abs(value - 7.86) < 1e-9, String(value));
});

test("an exalted price is worth far less than the same number of chaos", () => {
  // The direction is easy to invert silently and would overstate every trade price ~48x.
  const oneExalted = toChaos(makePoeNinja(RATES), 1, "exalted")!;

  assert.ok(oneExalted < 1, `1 exalted should be well under 1 chaos, got ${oneExalted}`);
});

test("other currencies fall through to poe.ninja's exchange slugs", () => {
  assert.equal(toChaos(makePoeNinja(RATES, { regal: 0.4 }), 5, "regal"), 2);
});

test("an unknown currency yields null rather than a made-up price", () => {
  assert.equal(toChaos(makePoeNinja(RATES), 5, "some-new-orb"), null);
});

test("before the first poe.ninja response, hub currencies fall back to the id lookup", () => {
  assert.equal(toChaos(makePoeNinja(null, { exalted: 0.021 }), 100, "exalted"), 2.1);
  assert.equal(toChaos(makePoeNinja(null), 100, "exalted"), null);
});
