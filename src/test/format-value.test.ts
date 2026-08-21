import assert from "node:assert/strict";
import { test } from "node:test";
import {
  convertFromChaos,
  formatHubRates,
  formatNumber,
  formatValue,
  pickDisplayUnit
} from "../shared/format-value";
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

test("auto steps divine, then chaos, then exalted as the value gets smaller", () => {
  assert.equal(formatValue(78.6, RATES), "10div");
  assert.equal(formatValue(7.86, RATES), "1div");
  // Chaos used to be skipped here, which sent everything under a divine into three-digit exalted
  // figures the moment a chaos was worth ~33 exalted rather than the ~48 this fixture predates.
  assert.equal(formatValue(2, RATES), "2c");
  assert.equal(formatValue(1, RATES), "1c");
  // Below one chaos the exalted figure is the readable one again.
  assert.equal(formatValue(0.05, RATES), "2.38ex");
});

test("a listing's own currency decides the unit, whatever size the number is", () => {
  // The point of persisting the quote: a row priced off a seller asking 2 chaos should read as the
  // market reads, not as the same value restated in another unit.
  assert.equal(formatValue(2, RATES, "auto", { amount: 2, currency: "chaos" }), "2c");
  assert.equal(formatValue(0.05, RATES, "auto", { amount: 1, currency: "chaos" }), "0.05c");
  assert.equal(formatValue(78.6, RATES, "auto", { amount: 150, currency: "exalted" }), "3,747ex");

  // The number still comes from the stored chaos value, never from the seller's amount — otherwise
  // the row and the map total would disagree about the same item the moment the rates moved.
  assert.equal(formatValue(7.86, RATES, "auto", { amount: 999, currency: "divine" }), "1div");
});

test("an explicit setting outranks the listing, and an unlabelled currency falls back", () => {
  const quote = { amount: 2, currency: "chaos" };
  assert.equal(formatValue(2, RATES, "exalted", quote), "95.3ex");
  // A quote in something with no unit label — an alch, a fragment — would otherwise print a unit
  // the header's rate line cannot explain.
  assert.equal(formatValue(2, RATES, "auto", { amount: 5, currency: "alch" }), "2c");
});

test("pickDisplayUnit is the rule the headline price reads", () => {
  assert.equal(pickDisplayUnit(2, RATES, "auto"), "chaos");
  assert.equal(pickDisplayUnit(0.5, RATES, "auto"), "exalted");
  assert.equal(pickDisplayUnit(100, RATES, "auto"), "divine");
  assert.equal(pickDisplayUnit(100, RATES, "auto", { amount: 2, currency: "chaos" }), "chaos");
  assert.equal(pickDisplayUnit(100, RATES, "chaos", { amount: 1, currency: "divine" }), "chaos");
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
