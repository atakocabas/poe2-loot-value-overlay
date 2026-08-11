import assert from "node:assert/strict";
import { test } from "node:test";
import { TradeSearchBudget } from "../pricing/trade-budget";

/** A hand-cranked clock, so window/spacing behaviour is asserted without any real waiting. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

test("the first search goes out immediately", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget(10, 300_000, 5000, clock.now);

  assert.equal(budget.reserve(), 0);
});

test("back-to-back searches are spaced by minIntervalMs, not fired together", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget(10, 300_000, 5000, clock.now);

  assert.equal(budget.reserve(), 0);
  // Same tick — a check-then-record design would return 0 here too and blow GGG's 5-per-10s bucket.
  assert.equal(budget.reserve(), 5000);
  assert.equal(budget.reserve(), 10_000);
});

test("a search that already waited out the interval doesn't wait again", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget(10, 300_000, 5000, clock.now);

  budget.reserve();
  clock.advance(6000);

  assert.equal(budget.reserve(), 0);
});

test("declines rather than waits once the window budget is spent", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget(3, 300_000, 0, clock.now);

  assert.equal(budget.reserve(), 0);
  assert.equal(budget.reserve(), 0);
  assert.equal(budget.reserve(), 0);
  // The whole point: this must be null (skip the item) and not a 5-minute sleep, which would stall
  // the pricing queue and every poe.ninja-priceable drop behind it.
  assert.equal(budget.reserve(), null);
});

test("slots free up once they age out of the window", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget(2, 300_000, 0, clock.now);

  budget.reserve();
  budget.reserve();
  assert.equal(budget.reserve(), null);

  clock.advance(300_000);

  assert.equal(budget.reserve(), 0);
});

test("cooldownMs counts down to the oldest slot expiring, and is 0 while budget remains", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget(2, 300_000, 0, clock.now);

  budget.reserve();
  assert.equal(budget.cooldownMs(), 0, "budget still available — nothing to wait for");

  budget.reserve();
  clock.advance(120_000);

  assert.equal(budget.cooldownMs(), 180_000);
});

test("a zero budget declines everything, so the setting can switch searches off", () => {
  const budget = new TradeSearchBudget(0, 300_000, 5000, fakeClock().now);

  assert.equal(budget.reserve(), null);
});
