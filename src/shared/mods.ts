import type { ParsedItem, ParsedMod } from "./types";

/**
 * An item's mod lines with their kinds.
 *
 * `ParsedItem.mods` was added after items were already being persisted, and `loot-cache.json` is
 * read back as-is with no migration step, so anything captured before then has only the two
 * flattened arrays. Rather than let that surface as `undefined` at the one place that cares (stat
 * matching for a trade search), reconstruct the best available approximation: implicit lines are
 * still known to be implicit, and everything else is assumed explicit — which is exactly what the
 * parser produced back then anyway.
 */
export function modsOf(item: Pick<ParsedItem, "mods" | "implicitMods" | "explicitMods">): ParsedMod[] {
  if (item.mods && item.mods.length > 0) return item.mods;
  return [
    ...(item.implicitMods ?? []).map((text): ParsedMod => ({ text, kind: "implicit" })),
    ...(item.explicitMods ?? []).map((text): ParsedMod => ({ text, kind: "explicit" }))
  ];
}
