import type { ItemWeaponStats, ParsedItem } from "./types";

const NO_WEAPON_STATS: ItemWeaponStats = { elementalDamage: null, attacksPerSecond: null };

/**
 * A weapon's damage factors, or all-null for an item captured before they were parsed.
 *
 * Same reason `defencesOf()`, `mapStatsOf()` and `modsOf()` exist: `loot-cache.json` is read back
 * as-is with no migration, so an older item has no `weapon` key and reading
 * `item.weapon.attacksPerSecond` throws. All-null means "no elemental DPS constraint", which is
 * exactly how this app searched before, so an old weapon simply gets the old query.
 */
export function weaponStatsOf(item: Pick<ParsedItem, "weapon">): ItemWeaponStats {
  return item.weapon ?? NO_WEAPON_STATS;
}

/**
 * The item's elemental DPS — what GGG indexes as `equipment_filters.edps` — or null when it prints
 * neither factor.
 *
 * Damage per hit times attacks per second, which is the whole definition. Both halves are required:
 * a weapon with elemental damage and no attack rate is not a weapon, it is a parse that missed a
 * line, and inventing a number from one factor would be worse than sending no filter.
 *
 * Unlike the defence totals this needs **no quality correction and no ratio to absorb one**. Quality
 * on a PoE2 weapon raises physical damage only, so the printed elemental damage is the same number a
 * 0% and a 20% copy of the base would both show — the skew that `defenceMinRatio` exists partly to
 * cover simply isn't here.
 */
export function elementalDpsOf(item: Pick<ParsedItem, "weapon">): number | null {
  const { elementalDamage, attacksPerSecond } = weaponStatsOf(item);
  if (elementalDamage === null || attacksPerSecond === null) return null;
  return elementalDamage * attacksPerSecond;
}

/**
 * The one shape that folds: `Adds 12 to 25 Fire Damage`, anchored end to end.
 *
 * Anchoring is what separates the local roll from the global one, and the two are otherwise
 * word-for-word identical up to the tail. `Adds 5 to 9 Fire Damage to Attacks` on a ring adds nothing
 * to any weapon's printed line — it is a stat GGG indexes on its own — and fails here on the tail.
 *
 * **`#% increased Elemental Damage` deliberately does not fold.** It does not move the printed
 * `Elemental Damage:` line the way `#% increased Armour` moves the armour total, so folding it would
 * delete a real stat from the search and put nothing in its place. Same restraint as the defence
 * patterns being built from the defence names rather than a loose tail.
 */
const LOCAL_ELEMENTAL_DAMAGE = /^Adds \+?[\d.]+ to \+?[\d.]+ (?:Fire|Cold|Lightning) Damage$/i;

/**
 * Whether this mod's roll is already inside the weapon's printed elemental damage, and should
 * therefore not also become a stat filter.
 *
 * Both halves are load-bearing, exactly as in `isLocalDefenceMod`. The shape test alone would fold
 * the mod on an item that displays no elemental damage at all — a caster's `Adds # to # Fire Damage
 * to Spells` variant, or a capture whose property block never parsed — and the roll would then
 * constrain nothing at all, since there would be no `edps` filter to have absorbed it.
 */
export function isLocalElementalDamageMod(text: string, weapon: ItemWeaponStats): boolean {
  if (weapon.elementalDamage === null) return false;
  return LOCAL_ELEMENTAL_DAMAGE.test(text);
}
