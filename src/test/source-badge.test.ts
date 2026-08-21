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

test("an item stored before the reason existed still reads 'unpriced'", () => {
  // The no-migration contract. Nothing rewrites `loot-cache.json`, so every item captured before
  // this field must keep rendering exactly as it did — absent means "no price, and nothing more to
  // say about it", which is the honest reading of a reason that old.
  const badge = loadSourceBadge()(unpricedItem());

  assert.equal(badge.textContent, "unpriced");
  assert.ok(badge.classes.includes("badge-unpriced"));
  assert.equal(badge.title, "", "there is nothing recorded to explain");
});

test("a reason from a newer build falls back rather than showing a raw code", () => {
  // The renderer and the store are versioned together, but a downgrade leaves items carrying codes
  // this table has never heard of. Printing `someNewReason` on the row would be worse than the one
  // word this all started as — and the detail, which is prose either way, still survives.
  const badge = loadSourceBadge()(
    unpricedItem({
      unpricedReason: "somethingThisBuildPredates" as PricedItem["unpricedReason"],
      unpricedDetail: "whatever the newer build had to say"
    })
  );

  assert.equal(badge.textContent, "unpriced");
  assert.ok(badge.classes.includes("badge-unpriced"));
  assert.equal(badge.title, "whatever the newer build had to say");
});

test("each reason gets its own word, and none of them is 'unpriced'", () => {
  // The point of the change: one word covered seven situations that ask different things of the
  // reader. If two of these ever collide, the badge has stopped distinguishing what it exists to.
  const sourceBadge = loadSourceBadge();
  const reasons: NonNullable<PricedItem["unpricedReason"]>[] = [
    "rateLimited",
    "pricesLoading",
    "searchFailed",
    "noListings",
    "unconvertible",
    "notSearchable",
    "notSearched",
    "noPriceData"
  ];

  const words = reasons.map((reason) => sourceBadge(unpricedItem({ unpricedReason: reason })).textContent);

  assert.equal(new Set(words).size, reasons.length, `two reasons share a word: ${words.join(", ")}`);
  assert.ok(!words.includes("unpriced"), "a mapped reason must say more than the word it replaced");
  // "not searched" is what the row editor badges individual mod rows, for an entirely different
  // reason. One word meaning two things across two surfaces of one panel is the confusion this
  // table exists to prevent.
  assert.ok(!words.includes("not searched"), "collides with the editor's per-mod marker");
});

test("only the reasons that resolve on their own are coloured as recoverable", () => {
  // The distinction worth carrying in colour, and the one that survived from the rate-limit badge:
  // blue means the answer is still coming, tan means the market has already given it. Getting this
  // backwards sends the user to press Reprice forever on an item that will never price.
  const sourceBadge = loadSourceBadge();
  const hue = (reason: NonNullable<PricedItem["unpricedReason"]>): string =>
    sourceBadge(unpricedItem({ unpricedReason: reason })).classes.includes("badge-ratelimited")
      ? "recoverable"
      : "final";

  assert.equal(hue("rateLimited"), "recoverable");
  assert.equal(hue("pricesLoading"), "recoverable");
  assert.equal(hue("searchFailed"), "recoverable");
  assert.equal(hue("noListings"), "final");
  assert.equal(hue("unconvertible"), "final");
  assert.equal(hue("notSearchable"), "final");
  assert.equal(hue("notSearched"), "final");
  assert.equal(hue("noPriceData"), "final");
});

test("the item's own detail is appended under the reason's generic hint", () => {
  // The generic sentence says what the state means; the detail says what happened to *this* item —
  // which ids were tried, how many mods had no listing. The badge is nearly useless without it, and
  // it has to be the resolver's own wording rather than a second one written here.
  const badge = loadSourceBadge()(
    unpricedItem({
      unpricedReason: "noListings",
      unpricedDetail: "no online listings match this Sapphire Ring on as few as 3 of its 5 mods"
    })
  );

  assert.match(badge.title, /the market has nothing matching this item/);
  assert.match(badge.title, /as few as 3 of its 5 mods/);
  assert.ok(badge.title.includes("\n\n"), "the two halves are separated, not run together");
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

test("a stale reason on a priced item never shows", () => {
  // Nothing migrates `loot-cache.json`, and the reprice path clears the field rather than leaving it
  // — but the badge is keyed on `priceSource` first, so a leftover reason can't surface as a label.
  const badge = loadSourceBadge()(
    unpricedItem({ chaosValue: 5, priceSource: "trade2", unpricedReason: "rateLimited" })
  );

  assert.equal(badge.textContent, "trade");
  assert.ok(!badge.classes.includes("badge-ratelimited"));
});
