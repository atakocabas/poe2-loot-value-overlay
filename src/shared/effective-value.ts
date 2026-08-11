import type { PricedItem } from "./types";

/** The value to actually use for an item: a manual override always wins over the auto-priced value. */
export function effectiveChaosValue(item: Pick<PricedItem, "manualChaosValue" | "chaosValue">): number | null {
  return item.manualChaosValue ?? item.chaosValue;
}

/**
 * What the pickup is worth in total, i.e. per-unit value times the stack that dropped.
 *
 * Prices are stored per-unit, so every consumer has to remember the multiply. It was open-coded in
 * three places (session totals, the feed, the item rows) and a fourth would have forgotten
 * it, undercounting every currency stack.
 */
export function totalChaosValue(
  item: Pick<PricedItem, "manualChaosValue" | "chaosValue" | "stackSize">
): number | null {
  const perUnit = effectiveChaosValue(item);
  return perUnit === null ? null : perUnit * item.stackSize;
}
