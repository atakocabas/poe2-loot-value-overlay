import type { PoeNinjaClient } from "./poeninja-client";

/**
 * Converts a trade listing's price (e.g. 3 "divine") into chaos, the app's storage unit.
 *
 * Trade listings name currencies by GGG's trade *id* ("exalted"), not the display name poe.ninja's
 * item lookup expects ("Exalted Orb"). For the three currencies that carry nearly all trade volume
 * the exact conversion is already in poe.ninja's `core.rates` block, so it is read straight from
 * there: that keeps working even if the Currency category isn't among the fetched types, and it
 * can't be thrown off by an unrelated slug that happens to collide with the id.
 *
 * Anything else falls through to the id lookup, which works only because poe.ninja's exchange slugs
 * ("regal", "vaal", "annul") happen to coincide with GGG's trade ids. Where they don't, this returns
 * null and the item stays unpriced — deliberately, since a wrong conversion would be stored as a
 * confident price with nothing to flag it.
 */
export function toChaos(poeNinja: PoeNinjaClient, amount: number, currency: string): number | null {
  if (currency === "chaos") return amount;

  const rates = poeNinja.getRates();
  if (rates) {
    if (currency === "divine") return amount * rates.chaosPerDivine;
    if (currency === "exalted") return amount * (rates.chaosPerDivine / rates.exaltedPerDivine);
  }

  const rate = poeNinja.getChaosValue(currency);
  return rate !== null ? amount * rate : null;
}
