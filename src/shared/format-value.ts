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
 * Picks the unit that puts the number in a readable range: divine once an item is worth at least
 * one, otherwise exalted. Chaos is never auto-selected — it sits awkwardly between the two and is
 * only useful when the user asks for it explicitly.
 */
function pickAutoUnit(chaos: number, rates: CurrencyRates): Exclude<DisplayCurrency, "auto"> {
  return chaos / rates.chaosPerDivine >= 1 ? "divine" : "exalted";
}

/**
 * `null` chaos means the item never got a price. Missing rates mean poe.ninja hasn't answered yet,
 * in which case the raw chaos figure is shown rather than a silently wrong conversion.
 */
export function formatValue(
  chaos: number | null,
  rates: CurrencyRates | null,
  displayCurrency: DisplayCurrency = "auto"
): string {
  if (chaos === null) return "?";
  if (!rates || !Number.isFinite(rates.chaosPerDivine) || rates.chaosPerDivine <= 0) {
    return `${formatNumber(chaos)}c`;
  }

  const unit = displayCurrency === "auto" ? pickAutoUnit(chaos, rates) : displayCurrency;
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
