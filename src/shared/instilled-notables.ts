import { modsOf } from "./mods";
import type { ParsedItem, ParsedMod } from "./types";

/**
 * The two amulet bases that drop with **two random instilled Notables** already on them — Delirium's
 * Loathsome Mire reward, and the only items in PoE2 that carry a notable pair.
 *
 * Their entire value is that pair. The base itself is a commodity: a bare `Distorted Amulet` search
 * returned 10000 listings (GGG's cap) against 490 for the same base carrying one named notable.
 *
 * Each also prints a downside implicit — `-1 Prefix Modifier allowed` on the Twisted, `-1 Suffix
 * Modifier allowed` on the Distorted — which is not searched: it is a property of the base, so every
 * listing the category search returns already has it.
 */
const INSTILLED_AMULET_BASES = new Set(["Twisted Amulet", "Distorted Amulet"]);

/**
 * Whether this item is one of the two instilled amulet bases, and so should be searched on its
 * notables rather than on the white-base item-level query or the ordinary rare ladder alone.
 *
 * Keyed off `baseType` rather than `itemClass`, which is the reverse of `isWaystone()` and for the
 * mirrored reason: `Amulets` covers every amulet in the game, while these two base *names* are the
 * only signal separating a two-notable drop from an ordinary anointed one. The name is exact and
 * unaffixed for the two rarities that reach trade2 — a Normal item's `baseType` is its name line, and
 * a Rare's is the line under it.
 *
 * **A Magic one is out of reach and that is not an oversight.** PoE2 glues the prefix and suffix onto
 * the base on one header line, so `baseType` for a Magic Twisted Amulet is "Rotund Twisted Amulet of
 * the Bear" and no exact test can fire. It is the same reason Magic items never reach trade2 at all —
 * see `price-resolver.ts`.
 */
export function isInstilledAmulet(item: Pick<ParsedItem, "baseType">): boolean {
  return INSTILLED_AMULET_BASES.has(item.baseType);
}

/**
 * Whether a mod line is an instilled notable — GGG's `Allocates <Notable>` stat.
 *
 * The negative lookahead is load-bearing rather than defensive. GGG's stat reference carries a
 * *second* stat starting with the same word, `explicit.stat_3929993388` = "Allocates # Sinister Jewel
 * sockets", which is a numeric stat and not a notable at all. Treating it as one would send it to the
 * enchant group (see `TradeStatsMatcher`), where it does not exist, and lose the filter entirely.
 */
export function isInstilledNotable(text: string): boolean {
  return /^Allocates (?!\d)/.test(text.trim());
}

/**
 * The item's instilled notables, read through `modsOf()` like every other mod accessor — items
 * persisted before `ParsedItem.mods` existed have only the flattened arrays.
 */
export function notablesOf(
  item: Pick<ParsedItem, "mods" | "implicitMods" | "explicitMods">
): ParsedMod[] {
  return modsOf(item).filter((mod) => isInstilledNotable(mod.text));
}
