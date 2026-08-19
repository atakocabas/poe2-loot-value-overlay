import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import type { PricedItem } from "../shared/types";

/**
 * `sourceBadge` lives in `src/renderer/common.ts`, which the renderer loads as a plain `<script>` and
 * which therefore exports nothing. Same arrangement as `item-groups.test.ts`: the compiled file is
 * run in a `vm` context and the function read off that context's global, which is how the page gets
 * it too. Here the `document` stub also has to build elements, since this function makes one.
 */
interface StubEl {
  className: string;
  textContent: string;
  title: string;
  classes: string[];
  classList: { add(name: string): void; remove(name: string): void };
}

function loadSourceBadge(): (item: PricedItem) => StubEl {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "common.js"), "utf-8");
  const context = vm.createContext({
    document: {
      getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      createElement: (): StubEl => {
        const classes: string[] = [];
        return {
          className: "",
          textContent: "",
          title: "",
          classes,
          classList: {
            add: (name: string) => void classes.push(name),
            remove: (name: string) => {
              const at = classes.indexOf(name);
              if (at >= 0) classes.splice(at, 1);
            }
          }
        };
      }
    }
  });
  vm.runInContext(source, context);

  const sourceBadge = (context as { sourceBadge?: (item: PricedItem) => StubEl }).sourceBadge;
  assert.ok(sourceBadge, "common.js no longer exposes sourceBadge on the script global");
  return sourceBadge;
}

function unpricedItem(overrides: Partial<PricedItem> = {}): PricedItem {
  return {
    chaosValue: null,
    priceSource: "unpriced",
    manualChaosValue: null,
    ...overrides
  } as PricedItem;
}

test("a rate-limited item says so instead of reading as an empty market", () => {
  // The whole point of the field: "unpriced" is a verdict on the item, and this isn't one. No search
  // ever went out, so the row has to send the user to wait and reprice rather than to bin the drop.
  const badge = loadSourceBadge()(unpricedItem({ unpricedReason: "rateLimited" }));

  assert.equal(badge.textContent, "rate limited");
  assert.ok(badge.classes.includes("badge-ratelimited"));
  assert.ok(!badge.classes.includes("badge-unpriced"), "the two states must not share a hue");
  assert.match(badge.title, /rate-limits by IP/);
  assert.match(badge.title, /Reprice/, "the badge has to name the way out");
});

test("an ordinary unpriced item is unchanged", () => {
  const badge = loadSourceBadge()(unpricedItem());

  assert.equal(badge.textContent, "unpriced");
  assert.ok(badge.classes.includes("badge-unpriced"));
  assert.equal(badge.title, "", "there is nothing recoverable to explain");
});

test("a manual price wins over the rate-limit badge", () => {
  // `manualChaosValue` returns early, and it should: the user has given this item a number, so how
  // the automatic lookup went is no longer what the row is reporting.
  const badge = loadSourceBadge()(
    unpricedItem({ unpricedReason: "rateLimited", manualChaosValue: 12 })
  );

  assert.equal(badge.textContent, "manual");
  assert.ok(!badge.classes.includes("badge-ratelimited"));
});

test("a stale flag on a priced item never shows", () => {
  // Nothing migrates `loot-cache.json`, and the reprice path clears the field rather than leaving it
  // — but the badge is keyed on `priceSource` first, so a leftover flag can't surface as a label.
  const badge = loadSourceBadge()(
    unpricedItem({ chaosValue: 5, priceSource: "trade2", unpricedReason: "rateLimited" })
  );

  assert.equal(badge.textContent, "trade");
  assert.ok(!badge.classes.includes("badge-ratelimited"));
});
