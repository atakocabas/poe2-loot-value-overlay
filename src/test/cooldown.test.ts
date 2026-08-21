import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { PricedItem } from "../shared/types";

/**
 * `formatCountdown` and `unpricedValueText` live in `src/renderer/common.ts`, which the renderer
 * loads as a plain `<script>` and which therefore exports nothing — see `item-groups.test.ts` for
 * why the compiled file is run in a `vm` and the functions read off that context's global.
 *
 * One wrinkle beyond the other renderer suites: the cooldown deadline is a top-level `let`, so it is
 * not a property of the context object the way a `function` declaration is. It lives in the realm's
 * **global lexical environment**, which every script run in that context shares — so a second
 * `runInContext` can assign it, which is what `setCooldown` below does. That is also how the page
 * itself reaches it from `index.js`.
 */
interface Harness {
  formatCountdown: (ms: number) => string;
  unpricedValueText: (item: PricedItem) => string;
  /** Sets the deadline the way OVERLAY_STATUS does, or clears it with null. */
  setCooldown: (until: number | null) => void;
}

function loadHarness(): Harness {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "common.js"), "utf-8");
  const context = vm.createContext({
    document: {
      getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      createElement: () => ({ className: "", textContent: "", title: "", dataset: {} })
    }
  });
  vm.runInContext(source, context);

  const picked = context as Partial<Harness>;
  assert.ok(picked.formatCountdown, "common.js no longer exposes formatCountdown");
  assert.ok(picked.unpricedValueText, "common.js no longer exposes unpricedValueText");

  return {
    formatCountdown: picked.formatCountdown,
    unpricedValueText: picked.unpricedValueText,
    setCooldown: (until) =>
      void vm.runInContext(`tradeCooldownUntil = ${until === null ? "null" : until}`, context)
  };
}

function rateLimitedItem(overrides: Partial<PricedItem> = {}): PricedItem {
  return {
    chaosValue: null,
    priceSource: "unpriced",
    manualChaosValue: null,
    unpricedReason: "rateLimited",
    ...overrides
  } as PricedItem;
}

describe("formatCountdown", () => {
  test("under a minute reads in bare seconds", () => {
    const { formatCountdown } = loadHarness();

    assert.equal(formatCountdown(47_000), "47s");
    assert.equal(formatCountdown(1_000), "1s");
  });

  test("under an hour reads as minutes and seconds", () => {
    const { formatCountdown } = loadHarness();

    assert.equal(formatCountdown(272_000), "4:32");
    assert.equal(formatCountdown(60_000), "1:00", "the seconds are padded, not dropped");
  });

  test("an hour or more grows a third field rather than counting minutes forever", () => {
    // The reason this has three tiers: `cooldownMs()` reports the longest wait across both budget
    // windows, and the long one is six hours. A plain mm:ss would render that as "360:00".
    const { formatCountdown } = loadHarness();

    assert.equal(formatCountdown(3_735_000), "1:02:15");
    assert.equal(formatCountdown(6 * 3_600_000), "6:00:00");
  });

  test("rounds up, so it never shows a zero that hasn't arrived", () => {
    // Ceil rather than floor: at 400ms left the search still can't go out, and "0s" would say it can.
    const { formatCountdown } = loadHarness();

    assert.equal(formatCountdown(400), "1s");
    assert.equal(formatCountdown(0), "0s");
  });

  test("a deadline already past never renders a negative", () => {
    const { formatCountdown } = loadHarness();

    assert.equal(formatCountdown(-5_000), "0s");
  });
});

describe("unpricedValueText", () => {
  test("a rate-limited row counts down to when the search can go out", () => {
    const harness = loadHarness();
    harness.setCooldown(Date.now() + 272_000);

    assert.equal(harness.unpricedValueText(rateLimitedItem()), "retry in 4:32");
  });

  test("with the budget refilled it says so, rather than showing a stale timer", () => {
    // The whole point of the change. `unpricedReason` persists on the item forever, so a row
    // rate-limited an hour ago used to keep claiming the "retry in ~90s" frozen into its detail
    // string. With no cooldown running, the honest answer is that pressing Reprice will work now.
    const harness = loadHarness();
    harness.setCooldown(null);

    assert.equal(harness.unpricedValueText(rateLimitedItem()), "ready to reprice");
  });

  test("a deadline that has already passed reads as ready, not as a negative countdown", () => {
    const harness = loadHarness();
    harness.setCooldown(Date.now() - 10_000);

    assert.equal(harness.unpricedValueText(rateLimitedItem()), "ready to reprice");
  });

  test("the countdown is global, so every rate-limited row reports the same wait", () => {
    // GGG limits by IP, so one window covers every item at once — there is deliberately no per-item
    // timestamp. A row rate-limited an hour ago shows the *current* cooldown because that really is
    // what pressing its Reprice button would run into.
    const harness = loadHarness();
    harness.setCooldown(Date.now() + 90_000);

    const older = rateLimitedItem({ capturedAt: 0 } as Partial<PricedItem>);
    const newer = rateLimitedItem({ capturedAt: Date.now() } as Partial<PricedItem>);
    assert.equal(harness.unpricedValueText(older), harness.unpricedValueText(newer));
  });

  test("no other reason gains a countdown", () => {
    // Only the rate limit resolves by waiting. "no listings" is the market's answer and does not
    // change on a timer; showing one would send the user to retry forever.
    const harness = loadHarness();
    harness.setCooldown(Date.now() + 272_000);

    const reasons: NonNullable<PricedItem["unpricedReason"]>[] = [
      "pricesLoading",
      "searchFailed",
      "noListings",
      "unconvertible",
      "notSearchable",
      "notSearched",
      "noPriceData"
    ];

    for (const reason of reasons) {
      const text = harness.unpricedValueText(rateLimitedItem({ unpricedReason: reason }));
      assert.doesNotMatch(text, /retry in|ready to reprice/, `${reason} must not count down`);
    }
  });

  test("an item stored before reasons existed still reads 'unpriced'", () => {
    const harness = loadHarness();
    harness.setCooldown(Date.now() + 272_000);

    assert.equal(harness.unpricedValueText(rateLimitedItem({ unpricedReason: undefined })), "unpriced");
  });
});
