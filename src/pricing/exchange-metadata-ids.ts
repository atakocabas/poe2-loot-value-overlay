/**
 * Display name -> Currency Exchange metadata id.
 *
 * GGG's Currency Exchange feed identifies items only by internal metadata path
 * (`Metadata/Items/Currency/CurrencyRerollRare`) and ships no name anywhere in the response, so a
 * table is the only way to get from a clipboard item name to a market.
 *
 * **These cannot be derived from poe.ninja.** poe.ninja's `image` field encodes an *art asset* path
 * (`2DItems/Currency/CurrencyVaal` for Vaal Orb) which frequently differs from the item's metadata
 * id (`CurrencyCorrupt` for that same orb) — matching on it agrees for only ~2% of traded ids.
 * Matching on price doesn't work either: hundreds of items sit within 10% of each other, so a
 * price lookup returns the wrong name far more often than the right one.
 *
 * Every entry below has been checked with `npm run verify:exchange-ids`, which prices the id off the
 * live exchange and compares it against poe.ninja's price for the name — a mismapping usually shows
 * up as a large disagreement. That check is *necessary but not sufficient* (same-priced items are
 * indistinguishable to it), so when adding an entry, read the id semantically as well: the paths are
 * descriptive (`CurrencyGemQuality` = the gem-quality currency = Gemcutter's Prism).
 *
 * A wrong entry silently reports another item's price, which is worse than no entry at all — an
 * unmapped name simply returns null and the item falls through to "unpriced". Prefer omitting an id
 * you are unsure of. Coverage is deliberately partial and biased toward what players actually pick
 * up; the verify script prints high-volume unmapped ids to grow this list from.
 */
const METADATA_ID_BY_NAME: Record<string, string> = {
  // --- Core orbs (the three hubs; rates for these are cross-checked against poe.ninja at runtime)
  "chaos orb": "Metadata/Items/Currency/CurrencyRerollRare",
  "divine orb": "Metadata/Items/Currency/CurrencyModValues",
  "exalted orb": "Metadata/Items/Currency/CurrencyAddModToRare",

  // --- Greater/Perfect tiers. The numeric suffix is the tier, consistently across families.
  "greater chaos orb": "Metadata/Items/Currency/CurrencyRerollRare2",
  "perfect chaos orb": "Metadata/Items/Currency/CurrencyRerollRare3",
  "greater exalted orb": "Metadata/Items/Currency/CurrencyAddModToRare2",
  "perfect exalted orb": "Metadata/Items/Currency/CurrencyAddModToRare3",
  "orb of transmutation": "Metadata/Items/Currency/CurrencyUpgradeToMagic",
  "greater orb of transmutation": "Metadata/Items/Currency/CurrencyUpgradeToMagic2",
  "perfect orb of transmutation": "Metadata/Items/Currency/CurrencyUpgradeToMagic3",
  "orb of augmentation": "Metadata/Items/Currency/CurrencyAddModToMagic",
  "greater orb of augmentation": "Metadata/Items/Currency/CurrencyAddModToMagic2",
  "perfect orb of augmentation": "Metadata/Items/Currency/CurrencyAddModToMagic3",
  "regal orb": "Metadata/Items/Currency/CurrencyUpgradeMagicToRare",
  "greater regal orb": "Metadata/Items/Currency/CurrencyUpgradeMagicToRare2",
  "perfect regal orb": "Metadata/Items/Currency/CurrencyUpgradeMagicToRare3",

  // --- Other orbs
  "orb of alchemy": "Metadata/Items/Currency/CurrencyUpgradeToRare",
  "orb of chance": "Metadata/Items/Currency/CurrencyUpgradeRandomly",
  "orb of annulment": "Metadata/Items/Currency/CurrencyRemoveMod",
  "vaal orb": "Metadata/Items/Currency/CurrencyCorrupt",
  "fracturing orb": "Metadata/Items/Currency/CurrencyFractureRare",
  "artificer's orb": "Metadata/Items/Currency/CurrencyAddEquipmentSocket",
  "lesser jeweller's orb": "Metadata/Items/Currency/CurrencyAddSkillGemSocket3",
  "greater jeweller's orb": "Metadata/Items/Currency/CurrencyAddSkillGemSocket4",
  "perfect jeweller's orb": "Metadata/Items/Currency/CurrencyAddSkillGemSocket5",

  // --- Quality / utility currencies. Named for what they upgrade, not for the item.
  "scroll of wisdom": "Metadata/Items/Currency/CurrencyIdentification",
  "armourer's scrap": "Metadata/Items/Currency/CurrencyArmourQuality",
  "blacksmith's whetstone": "Metadata/Items/Currency/CurrencyWeaponQuality",
  "glassblower's bauble": "Metadata/Items/Currency/CurrencyFlaskQuality",
  "gemcutter's prism": "Metadata/Items/Currency/CurrencyGemQuality",
  "arcanist's etcher": "Metadata/Items/Currency/CurrencyMagicQuality"
};

/** Metadata id for a display name, or null when the name isn't mapped. Case-insensitive. */
export function metadataIdForName(name: string): string | null {
  return METADATA_ID_BY_NAME[name.trim().toLowerCase()] ?? null;
}

/** Every mapped (name, id) pair — used by the verification script and its test. */
export function allMappedIds(): Array<{ name: string; metadataId: string }> {
  return Object.entries(METADATA_ID_BY_NAME).map(([name, metadataId]) => ({ name, metadataId }));
}
