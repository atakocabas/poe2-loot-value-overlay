import type { ParsedMod } from "./types";

/**
 * How far up a mod's own roll bracket the search floor sits: 0 is the bracket's minimum, 1 is the
 * item's exact roll.
 *
 * **A constant rather than a setting, and half rather than either end.** At 1 — which is what every
 * search sent before this existed — a filter demands a roll at least as good as this item's on
 * *every* mod at once, so the only matches are items strictly better than yours and a four-mod rare
 * routinely finds nothing. Two real jewels measured at **0** listings on all four of their mods, both
 * of which the player found by hand in seconds by widening each stat.
 *
 * At 0 the floor is the bracket's bottom, which is what the in-game market defaults to — the widest
 * option, and the one that stops distinguishing a max roll from a minimum one at the same tier.
 *
 * Half keeps that distinction (a better roll still asks for more) without demanding a perfect
 * comparable. Measured on the `Sapphire` this came from, with the same four mods: at the item's rolls
 * 0 listings, at half 12, at the bracket minimums 36 — and the player's own hand-drawn search, which
 * is the target this is aiming at, returned 13.
 */
export const MOD_ROLL_FLOOR_RATIO = 0.5;

/**
 * The number a mod is searched at: partway down from its roll toward its bracket's minimum.
 *
 * Falls back to the roll itself whenever the bracket is unknown — an item captured without
 * **Advanced Item Descriptions**, or before this was parsed — which is exactly the pre-feature
 * behaviour, so the absence costs specificity and never invents a wider search than the data
 * supports.
 *
 * The floor is never taken *above* the roll. A bracket whose minimum sits above the printed roll is
 * not something the game produces, but reading one would quietly ask for an item better than this
 * one on that stat, which is the whole failure this exists to remove.
 */
export function searchFloor(roll: number, range: ParsedMod["rollRange"]): number {
  if (!range || !Number.isFinite(range.min) || range.min >= roll) return roll;
  return Math.floor(range.min + (roll - range.min) * MOD_ROLL_FLOOR_RATIO);
}

/**
 * The first number on a mod line — the same one `TradeStatsMatcher` captures and filters on, and the
 * one `rollRange` brackets.
 */
const LEADING_NUMBER = /-?\d+(?:\.\d+)?/;

/** Every mod's search floor by display text, for the row editor's prefilled min boxes. */
export function searchFloorsByMod(mods: ParsedMod[]): Array<{ text: string; min: number }> {
  const floors: Array<{ text: string; min: number }> = [];
  for (const mod of mods) {
    const roll = mod.text.match(LEADING_NUMBER);
    if (!roll) continue;
    floors.push({ text: mod.text, min: searchFloor(Number(roll[0]), mod.rollRange) });
  }
  return floors;
}
