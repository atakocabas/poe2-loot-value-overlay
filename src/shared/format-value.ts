/**
 * Turning an internal chaos value into something readable.
 *
 * Values are stored in chaos throughout, but chaos is a poor *display* unit for PoE2: one chaos is
 * roughly 48 exalted and an eighth of a divine, so ordinary drops land far below 1 and the old
 * `toFixed(1)` rendered anything under 0.05c as a flat "0.0c". Exalted is the denomination players
 * actually quote small prices in, divine the one they quote large ones in.
 *
 * NOTE: this module is duplicated as inline functions in `src/renderer/index.ts`. The renderer
 * loads as a plain <script> and cannot import anything at runtime — see the comment at the top of
 * that file. Keep the two in sync; the tests here are what pin the behaviour.
 */

/** poe.ninja quotes everything against divine, so both rates are "how many of these per divine". */
export interface CurrencyRates {
  chaosPerDivine: number;
  exaltedPerDivine: number;
}

export type DisplayCurrency = "auto" | "exalted" | "chaos" | "divine";

const UNIT_LABEL: Record<Exclude<DisplayCurrency, "auto">, string> = {
  exalted: "ex",
  chaos: "c",
  divine: "div"
};

/** Two significant-ish digits: enough to compare drops, not so many the panel turns into noise. */
export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  // Something worth a fraction of a percent of the unit is still not nothing — rounding it to "0"
  // is what made the old display useless. Say it's small instead of claiming it's worthless.
  if (abs > 0 && abs < 0.01) return "<0.01";

  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const fixed = value.toFixed(decimals);
  // Strip trailing zeros so "1.50" reads as "1.5" and "3.00" as "3".
  const trimmed = decimals > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
  return Number(trimmed).toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export function convertFromChaos(
  chaos: number,
  rates: CurrencyRates,
  unit: Exclude<DisplayCurrency, "auto">
): number {
  if (unit === "chaos") return chaos;
  const divine = chaos / rates.chaosPerDivine;
  return unit === "divine" ? divine : divine * rates.exaltedPerDivine;
}

/**
 * What a trade2 listing was actually quoted in, as GGG hands it over: `{ amount: 2, currency: "chaos" }`.
 */
export interface ListingQuote {
  amount: number;
  currency: string;
}

/**
 * The three GGG currency ids this app can put a label on.
 *
 * Anything else a listing is quoted in — an alch, an annul, a fragment — falls through to the
 * magnitude rule rather than being printed with a unit the header's rate line cannot explain.
 */
const QUOTE_UNITS: Record<string, Exclude<DisplayCurrency, "auto">> = {
  chaos: "chaos",
  exalted: "exalted",
  divine: "divine"
};

/**
 * The unit a value is shown in.
 *
 * An explicit setting always wins. On `auto` the **listing's own currency wins next**, when there is
 * one: a row whose price came from a seller asking 2 chaos should say "2c", not the same value
 * restated as 66ex. That is the number the market is quoting and the number you would type into the
 * trade site, and it is the whole reason the quote is persisted.
 *
 * With no listing behind the value — poe.ninja, the currency exchange, a map total, a folded stack —
 * the unit comes from the size of the number instead: divine once it is worth at least one, chaos
 * down to one chaos, exalted below that. Chaos used to be skipped entirely here, which was defensible
 * when a chaos was worth a fraction of a divine and 48 exalted; at this league's rates one chaos is
 * ~33 exalted, so skipping it turned every ordinary drop into a three-digit exalted figure.
 */
export function pickDisplayUnit(
  chaos: number,
  rates: CurrencyRates,
  displayCurrency: DisplayCurrency,
  quote?: ListingQuote | null
): Exclude<DisplayCurrency, "auto"> {
  if (displayCurrency !== "auto") return displayCurrency;

  const quoted = quote ? QUOTE_UNITS[quote.currency] : undefined;
  if (quoted) return quoted;

  if (chaos / rates.chaosPerDivine >= 1) return "divine";
  return chaos >= 1 ? "chaos" : "exalted";
}

/**
 * `null` chaos means the item never got a price. Missing rates mean poe.ninja hasn't answered yet,
 * in which case the raw chaos figure is shown rather than a silently wrong conversion.
 */
export function formatValue(
  chaos: number | null,
  rates: CurrencyRates | null,
  displayCurrency: DisplayCurrency = "auto",
  quote?: ListingQuote | null
): string {
  if (chaos === null) return "?";
  if (!rates || !Number.isFinite(rates.chaosPerDivine) || rates.chaosPerDivine <= 0) {
    return `${formatNumber(chaos)}c`;
  }

  // The quote picks the *unit*; the number still comes from the stored chaos value. Printing the
  // seller's own amount instead would drift from everything else on the panel the moment the rates
  // moved, and would leave the row and the map total disagreeing about the same item.
  const unit = pickDisplayUnit(chaos, rates, displayCurrency, quote);
  return `${formatNumber(convertFromChaos(chaos, rates, unit))}${UNIT_LABEL[unit]}`;
}

/**
 * The three rates players actually quote, derived from the two poe.ninja publishes. Both of its
 * numbers are per divine, so exalted-per-chaos is the one that has to be worked out here.
 *
 * Beware the direction: exalted-per-chaos is `exaltedPerDivine / chaosPerDivine` (~48). Its
 * reciprocal (~0.02) is also a real quantity — it's chaos-per-exalted, what `toChaos()` in
 * pricing/currency-convert.ts multiplies by — and swapping the two produces a number that still
 * looks plausible at 10px. The tests pin the direction.
 *
 * Returns null when the rates can't produce all three, so the caller hides the line rather than
 * printing an Infinity or a confidently wrong 0. `exaltedPerDivine` needs the same finite/positive
 * check as `chaosPerDivine` because here it is a *divisor*, which it never is in `formatValue()`.
 */
export function formatHubRates(rates: CurrencyRates | null): string | null {
  if (!rates) return null;
  const { chaosPerDivine, exaltedPerDivine } = rates;
  if (!Number.isFinite(chaosPerDivine) || chaosPerDivine <= 0) return null;
  if (!Number.isFinite(exaltedPerDivine) || exaltedPerDivine <= 0) return null;

  return [
    `1div = ${formatNumber(chaosPerDivine)}${UNIT_LABEL.chaos}`,
    `1div = ${formatNumber(exaltedPerDivine)}${UNIT_LABEL.exalted}`,
    `1${UNIT_LABEL.chaos} = ${formatNumber(exaltedPerDivine / chaosPerDivine)}${UNIT_LABEL.exalted}`
  ].join(" · ");
}
