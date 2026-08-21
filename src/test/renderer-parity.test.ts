import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, test } from "node:test";
import { convertFromChaos, formatHubRates, formatNumber, formatValue, pickDisplayUnit } from "../shared/format-value";
import type { CurrencyRates, DisplayCurrency, ListingQuote } from "../shared/format-value";
import { modsOf } from "../shared/mods";
import type { ParsedMod, PricedItem } from "../shared/types";

/**
 * The renderer's copies of the `shared/` helpers must agree with their originals.
 *
 * `src/renderer/common.ts` loads as a plain `<script>` and can import nothing at runtime, so a
 * handful of helpers are duplicated there by hand with a "keep them in sync" comment. Nothing
 * enforced that comment: `format-value.test.ts` exercises only the `shared/` copy, while the
 * renderer's duplicate is the one that actually draws every number on the panel. A fix applied to one
 * and not the other is invisible until a player reads a wrong price.
 *
 * The vm harness is the same one `item-groups.test.ts`, `listed-age.test.ts` and
 * `source-badge.test.ts` use — the compiled file runs as a script in a `vm` context and the functions
 * are read off that context's global, which is how the page itself gets them.
 *
 * Two signature differences are deliberate and are bridged below rather than "fixed": the renderer's
 * `formatValue` and `pickDisplayUnit` read `rates` and `displayCurrency` from module-level state,
 * because every call site on the panel would otherwise thread the same two values through. Those are
 * `let` bindings, so they live in the context's global *lexical* scope rather than on its global
 * object — assigning them takes a second `runInContext` in the same context, not a property write.
 */

interface RendererCopies {
  formatNumber(value: number): string;
  convertFromChaos(chaos: number, rates: CurrencyRates, unit: Exclude<DisplayCurrency, "auto">): number;
  pickDisplayUnit(chaos: number, rates: CurrencyRates, quote?: ListingQuote | null): Exclude<DisplayCurrency, "auto">;
  formatValue(chaos: number | null, quote?: ListingQuote | null): string;
  formatHubRates(rates: CurrencyRates | null): string | null;
  itemMods(item: PricedItem): ParsedMod[];
  setState(rates: CurrencyRates | null, displayCurrency: DisplayCurrency): void;
}

function loadRenderer(): RendererCopies {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "common.js"), "utf-8");
  const context = vm.createContext({
    document: { getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }) }
  });
  vm.runInContext(source, context);

  const copies = context as unknown as RendererCopies;
  for (const name of ["formatNumber", "convertFromChaos", "pickDisplayUnit", "formatValue", "formatHubRates", "itemMods"] as const) {
    assert.equal(typeof copies[name], "function", `common.js no longer exposes ${name} on the script global`);
  }

  copies.setState = (rates, displayCurrency) => {
    vm.runInContext(
      `rates = ${JSON.stringify(rates)}; displayCurrency = ${JSON.stringify(displayCurrency)};`,
      context
    );
  };
  return copies;
}

const renderer = loadRenderer();

/**
 * Strips the realm off a value the vm handed back.
 *
 * Objects built inside the context have that context's `Object.prototype`, and `deepStrictEqual`
 * compares prototypes — so two structurally identical mod lists fail with a diff showing no
 * difference at all. Only the object-returning comparison needs this; the rest return strings and
 * numbers, which cross realms as primitives.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Live poe.ninja rates, as `format-value.test.ts` uses them: 1 divine = 7.86c = 374.7ex. */
const RATES: CurrencyRates = { chaosPerDivine: 7.86, exaltedPerDivine: 374.7 };

/**
 * Every boundary either copy branches on, so a divergence in any one of them is caught: the
 * `<0.01` floor, the three decimal bands (>=100, >=10, below), the trailing-zero strip, the
 * divine/chaos/exalted magnitude steps, zero and a negative.
 */
const VALUES = [0, 0.001, 0.009, 0.01, 0.05, 0.5, 1, 1.5, 3, 7.85, 7.86, 9.99, 10, 15.04, 99.5, 100, 1234.5, -4.2];

describe("the renderer's duplicated helpers match their shared/ originals", () => {
  test("formatNumber", () => {
    for (const value of VALUES) {
      assert.equal(renderer.formatNumber(value), formatNumber(value), `formatNumber(${value})`);
    }
  });

  test("convertFromChaos", () => {
    for (const value of VALUES) {
      for (const unit of ["chaos", "exalted", "divine"] as const) {
        assert.equal(
          renderer.convertFromChaos(value, RATES, unit),
          convertFromChaos(value, RATES, unit),
          `convertFromChaos(${value}, ${unit})`
        );
      }
    }
  });

  test("pickDisplayUnit, across every display setting and both quote states", () => {
    const quotes: Array<ListingQuote | null> = [
      null,
      { amount: 2, currency: "chaos" },
      { amount: 1, currency: "divine" },
      { amount: 40, currency: "exalted" },
      // A currency with no label must fall through to the magnitude rule in both copies.
      { amount: 3, currency: "alch" }
    ];

    for (const displayCurrency of ["auto", "exalted", "chaos", "divine"] as const) {
      renderer.setState(RATES, displayCurrency);
      for (const value of VALUES) {
        for (const quote of quotes) {
          assert.equal(
            renderer.pickDisplayUnit(value, RATES, quote),
            pickDisplayUnit(value, RATES, displayCurrency, quote),
            `pickDisplayUnit(${value}, ${displayCurrency}, ${JSON.stringify(quote)})`
          );
        }
      }
    }
  });

  test("formatValue, including the no-price and no-rates fallbacks", () => {
    const quotes: Array<ListingQuote | null> = [null, { amount: 2, currency: "chaos" }, { amount: 5, currency: "alch" }];

    for (const displayCurrency of ["auto", "exalted", "chaos", "divine"] as const) {
      // A null rate block means poe.ninja hasn't answered yet; both copies must fall back to raw
      // chaos rather than converting through a divisor they don't have.
      for (const rates of [RATES, null]) {
        renderer.setState(rates, displayCurrency);
        for (const value of [...VALUES, null]) {
          for (const quote of quotes) {
            assert.equal(
              renderer.formatValue(value, quote),
              formatValue(value, rates, displayCurrency, quote),
              `formatValue(${value}, rates=${rates ? "live" : "null"}, ${displayCurrency}, ${JSON.stringify(quote)})`
            );
          }
        }
      }
    }
  });

  test("formatHubRates, including the rates it must refuse to print", () => {
    const cases: Array<CurrencyRates | null> = [
      RATES,
      null,
      { chaosPerDivine: 0, exaltedPerDivine: 374.7 },
      { chaosPerDivine: 7.86, exaltedPerDivine: 0 },
      { chaosPerDivine: Number.NaN, exaltedPerDivine: 374.7 },
      { chaosPerDivine: 7.86, exaltedPerDivine: Number.POSITIVE_INFINITY }
    ];

    for (const rates of cases) {
      assert.equal(renderer.formatHubRates(rates), formatHubRates(rates), `formatHubRates(${JSON.stringify(rates)})`);
    }
  });

  test("itemMods matches modsOf, including the pre-`mods` persisted shape", () => {
    // `mods`/`implicitMods`/`explicitMods` are declared non-optional, but `modsOf` exists precisely
    // because `loot-cache.json` is read back with no migration and older items are missing them —
    // so the shapes worth testing are ones the type says cannot happen.
    type ModShape = {
      mods?: ParsedMod[];
      implicitMods?: string[];
      explicitMods?: string[];
    };
    const mods: ParsedMod[] = [{ text: "+42 to maximum Life", kind: "explicit" }];
    const implicitMods = ["+10% to Cold Resistance"];
    const explicitMods = ["+42 to maximum Life"];

    const shapes: ModShape[] = [
      { mods, implicitMods, explicitMods },
      // An item stored before `mods` existed — the case modsOf() is entirely about.
      { implicitMods, explicitMods },
      { mods: [], implicitMods, explicitMods },
      {},
      { implicitMods: [], explicitMods }
    ];

    for (const shape of shapes) {
      assert.deepEqual(
        plain(renderer.itemMods(shape as PricedItem)),
        plain(modsOf(shape as PricedItem)),
        `itemMods(${JSON.stringify(shape)})`
      );
    }
  });
});
