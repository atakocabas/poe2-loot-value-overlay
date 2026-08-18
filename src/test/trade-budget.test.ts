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
  const budget = new TradeSearchBudget([{ max: 10, windowMs: 300_000 }], 5000, clock.now);

  assert.equal(budget.reserve(), 0);
});

test("back-to-back searches are spaced by minIntervalMs, not fired together", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget([{ max: 10, windowMs: 300_000 }], 5000, clock.now);

  assert.equal(budget.reserve(), 0);
  // Same tick — a check-then-record design would return 0 here too and blow GGG's 5-per-10s bucket.
  assert.equal(budget.reserve(), 5000);
  assert.equal(budget.reserve(), 10_000);
});

test("a search that already waited out the interval doesn't wait again", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget([{ max: 10, windowMs: 300_000 }], 5000, clock.now);

  budget.reserve();
  clock.advance(6000);

  assert.equal(budget.reserve(), 0);
});

test("declines rather than waits once the window budget is spent", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget([{ max: 3, windowMs: 300_000 }], 0, clock.now);

  assert.equal(budget.reserve(), 0);
  assert.equal(budget.reserve(), 0);
  assert.equal(budget.reserve(), 0);
  // The whole point: this must be null (skip the item) and not a 5-minute sleep, which would stall
  // the pricing queue and every poe.ninja-priceable drop behind it.
  assert.equal(budget.reserve(), null);
});

test("slots free up once they age out of the window", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget([{ max: 2, windowMs: 300_000 }], 0, clock.now);

  budget.reserve();
  budget.reserve();
  assert.equal(budget.reserve(), null);

  clock.advance(300_000);

  assert.equal(budget.reserve(), 0);
});

test("cooldownMs counts down to the oldest slot expiring, and is 0 while budget remains", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget([{ max: 2, windowMs: 300_000 }], 0, clock.now);

  budget.reserve();
  assert.equal(budget.cooldownMs(), 0, "budget still available — nothing to wait for");

  budget.reserve();
  clock.advance(120_000);

  assert.equal(budget.cooldownMs(), 180_000);
});

test("the long window still declines once the short one has refilled many times over", () => {
  // GGG's 6-hour bucket is the one with an hour-long lockout, and the short window can't see it:
  // 5 searches per 5 minutes refills 12 times an hour, so a session outruns a 6-hour cap long
  // before any single short window is full.
  const clock = fakeClock();
  const budget = new TradeSearchBudget(
    [
      { max: 5, windowMs: 300_000 },
      { max: 8, windowMs: 21_600_000 }
    ],
    0,
    clock.now
  );

  for (let i = 0; i < 8; i++) {
    assert.equal(budget.reserve(), 0, `search ${i + 1} should be within both budgets`);
    clock.advance(600_000); // a fresh short window every time
  }

  assert.equal(budget.reserve(), null, "the long window is spent even though the short one is empty");
});

test("cooldownMs reports the long window's wait, not the short window's shorter one", () => {
  // Reporting the short window here would send the user to press Reprice at a moment when the
  // search still cannot go out — the message has to name the wait that actually binds.
  const clock = fakeClock();
  const budget = new TradeSearchBudget(
    [
      { max: 2, windowMs: 300_000 },
      { max: 2, windowMs: 21_600_000 }
    ],
    0,
    clock.now
  );

  budget.reserve();
  budget.reserve();
  clock.advance(299_000);

  // The short window frees a slot in 1s; the long one holds it for another ~5.9 hours.
  assert.equal(budget.cooldownMs(), 21_600_000 - 299_000);
});

test("a slot aging out of the short window is still counted by the long one", () => {
  const clock = fakeClock();
  const budget = new TradeSearchBudget(
    [
      { max: 2, windowMs: 300_000 },
      { max: 3, windowMs: 21_600_000 }
    ],
    0,
    clock.now
  );

  budget.reserve();
  budget.reserve();
  clock.advance(300_000); // both short-window slots have expired

  assert.equal(budget.reserve(), 0, "the short window has room again");
  // ...but that was the third search of the long window, which only allows three.
  assert.equal(budget.reserve(), null);
});

test("a zero budget declines everything, so the setting can switch searches off", () => {
  const budget = new TradeSearchBudget([{ max: 0, windowMs: 300_000 }], 5000, fakeClock().now);

  assert.equal(budget.reserve(), null);
});
