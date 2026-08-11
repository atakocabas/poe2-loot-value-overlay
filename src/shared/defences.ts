import type { ItemDefences, ParsedItem } from "./types";

const NO_DEFENCES: ItemDefences = { armour: null, evasion: null, energyShield: null, ward: null };

/**
 * An item's defence totals, or all-null for one captured before they were parsed.
 *
 * Same reason `modsOf()` exists: `loot-cache.json` is read back as-is with no migration, so an
 * older item has no `defences` key at all and reading `item.defences.armour` throws. All-null is
 * the correct fallback — it means "no defence constraint", which is exactly how this app behaved
 * before, so an old item simply gets the old search.
 */
export function defencesOf(item: Pick<ParsedItem, "defences">): ItemDefences {
  return item.defences ?? NO_DEFENCES;
}

/** Which `ItemDefences` key each defence name in a mod line contributes to. */
const DEFENCE_WORDS: Array<{ pattern: RegExp; key: keyof ItemDefences }> = [
  { pattern: /\bArmour\b/i, key: "armour" },
  { pattern: /\bEvasion\b/i, key: "evasion" },
  { pattern: /\bEnergy Shield\b/i, key: "energyShield" },
  { pattern: /\bRunic Ward\b/i, key: "ward" }
];

/** One or more defence names joined the way the game writes them: "Armour, Evasion and Energy Shield". */
const NAME = "Armour|Evasion(?: Rating)?|Energy Shield|Runic Ward";
const NAME_LIST = `(?:${NAME})(?:(?:,| and) (?:${NAME}))*`;

/**
 * The two shapes a *local* defence mod takes, after `stripRollRanges` has run:
 *   `+186 to Armour`, `+47 to maximum Energy Shield`
 *   `38% increased Armour`, `36% increased Armour, Evasion and Energy Shield`
 *
 * Anchored end to end, and the tail is built from the defence names rather than "any words" — a
 * looser pattern folds away `10% increased Armour during Soul Gain Prevention`, which is a
 * conditional stat GGG indexes separately and no property line accounts for. Likewise `Gain 30% of
 * Armour as Extra Energy Shield` fails at the front, since it doesn't open with a number.
 */
const FLAT_DEFENCE = new RegExp(`^\\+?[\\d.]+ to (?:maximum )?(?:${NAME_LIST})$`, "i");
const INCREASED_DEFENCE = new RegExp(`^[\\d.]+% increased (?:${NAME_LIST})$`, "i");

/**
 * Whether this mod's contribution is already counted inside one of the item's displayed defence
 * totals, and should therefore not also become a stat filter.
 *
 * Both halves are load-bearing. The shape test alone would fold `+40 to maximum Energy Shield` on a
 * ring, where that mod is *global* and no property line absorbs it — the text is identical to the
 * local version on a body armour, and the presence of an `Energy Shield:` line is the only thing
 * that distinguishes them. Same for `#% increased Armour` on a belt versus on a shield.
 *
 * "At least one named defence is displayed" rather than all of them: a rune granting `36% increased
 * Armour, Evasion and Energy Shield` on a base with no energy shield still had its armour and
 * evasion halves folded into those totals, and its ES half contributed nothing to anything.
 */
export function isLocalDefenceMod(text: string, defences: ItemDefences): boolean {
  if (!FLAT_DEFENCE.test(text) && !INCREASED_DEFENCE.test(text)) return false;
  return DEFENCE_WORDS.some(({ pattern, key }) => pattern.test(text) && defences[key] !== null);
}
