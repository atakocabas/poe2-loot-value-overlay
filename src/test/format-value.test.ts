import assert from "node:assert/strict";
import { test } from "node:test";
import { convertFromChaos, formatHubRates, formatNumber, formatValue } from "../shared/format-value";
import type { CurrencyRates } from "../shared/format-value";

// Copied from a live poe.ninja response: rates are per divine, so 1 divine = 7.86c = 374.7ex.
const RATES: CurrencyRates = { chaosPerDivine: 7.86, exaltedPerDivine: 374.7 };

test("chaos converts to the unit players actually quote", () => {
  assert.equal(convertFromChaos(7.86, RATES, "divine"), 1);
  assert.equal(convertFromChaos(7.86, RATES, "exalted"), 374.7);
  assert.equal(convertFromChaos(3, RATES, "chaos"), 3);
  // One chaos is worth ~48 exalted in PoE2 — the opposite of the PoE1 intuition.
  assert.ok(Math.abs(convertFromChaos(1, RATES, "exalted") - 47.67) < 0.01);
});

test("auto picks divine once an item is worth one, exalted below that", () => {
  assert.equal(formatValue(78.6, RATES), "10div");
  assert.equal(formatValue(7.86, RATES), "1div");
  assert.equal(formatValue(1, RATES), "47.7ex");
  assert.equal(formatValue(0.05, RATES), "2.38ex");
});

test("small values are no longer flattened to zero", () => {
  // The old display was toFixed(1) on chaos, so every one of these rendered as "0.0c".
  assert.equal(formatValue(0.04, RATES), "1.91ex");
  assert.equal(formatValue(0.002, RATES), "0.1ex");
  assert.equal(formatValue(0.00001, RATES), "<0.01ex");
  assert.equal(formatValue(0, RATES), "0ex");
});

test("an explicit display currency overrides the automatic choice", () => {
  assert.equal(formatValue(78.6, RATES, "chaos"), "78.6c");
  assert.equal(formatValue(78.6, RATES, "exalted"), "3,747ex");
  assert.equal(formatValue(1, RATES, "divine"), "0.13div");
});

test("an unpriced item and a missing rate table are both stated, not guessed at", () => {
  assert.equal(formatValue(null, RATES), "?");
  assert.equal(formatValue(null, null), "?");
  // Before poe.ninja's first response there is no conversion; show the stored unit as-is rather
  // than silently converting with a made-up rate.
  assert.equal(formatValue(12.5, null), "12.5c");
  assert.equal(formatValue(12.5, { chaosPerDivine: 0, exaltedPerDivine: 374.7 }), "12.5c");
});

test("the header states all three hub rates on one line", () => {
  assert.equal(formatHubRates(RATES), "1div = 7.86c · 1div = 375ex · 1c = 47.7ex");
});

test("a chaos is worth tens of exalted, not a fraction of one", () => {
  // chaosPerDivine / exaltedPerDivine (~0.02) is also a real rate — it's chaos-per-exalted — so an
  // inverted ratio here still renders a plausible-looking number. Pin the magnitude.
  const exaltedPerChaos = Number(formatHubRates(RATES)!.split("1c = ")[1]!.replace("ex", ""));
  assert.ok(exaltedPerChaos > 1, `expected tens of exalted per chaos, got ${exaltedPerChaos}`);
  assert.ok(Math.abs(exaltedPerChaos - 47.7) < 0.05);
});

test("rates that can't produce all three ratios are withheld rather than guessed at", () => {
  // Before poe.ninja's first response there is nothing to show at all.
  assert.equal(formatHubRates(null), null);
  assert.equal(formatHubRates({ chaosPerDivine: 0, exaltedPerDivine: 374.7 }), null);
  // exaltedPerDivine is the divisor for the chaos->exalted leg, so a zero here would print Infinity.
  assert.equal(formatHubRates({ chaosPerDivine: 7.86, exaltedPerDivine: 0 }), null);
  assert.equal(formatHubRates({ chaosPerDivine: Number.NaN, exaltedPerDivine: 374.7 }), null);
  assert.equal(formatHubRates({ chaosPerDivine: 7.86, exaltedPerDivine: Number.POSITIVE_INFINITY }), null);
});

test("precision scales with magnitude and drops trailing zeros", () => {
  assert.equal(formatNumber(1234.5), "1,235");
  assert.equal(formatNumber(12.34), "12.3");
  assert.equal(formatNumber(1.5), "1.5");
  assert.equal(formatNumber(3), "3");
  assert.equal(formatNumber(10), "10");
});
