/**
 * The sample loot the README's screenshots are taken of.
 *
 * **Invented, not measured.** Every price here was chosen to look plausible and to make a particular
 * piece of the UI draw — a relaxed trade rung, a rate-limit countdown, each unpriced badge. Nothing
 * in this file is evidence of what anything is worth, and it must never be cited as such; the
 * measured numbers in docs/pricing-trade2.md came from live GGG responses instead.
 *
 * Read by scripts/screenshot-preload.js, which serves it to the real renderer in place of the IPC
 * bridge. Shapes are `PricedItem` and `OverlayStatus` from src/shared/types.ts — this is plain JS
 * because nothing in scripts/ is compiled, so keep it in step with those types by hand.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Frozen so every run of the harness produces the same PNGs — a wall clock would not. */
const NOW = Date.UTC(2026, 0, 14, 20, 30, 0);

const EMPTY_DEFENCES = { armour: null, evasion: null, energyShield: null, ward: null };
const EMPTY_WEAPON = { elementalDamage: null, attacksPerSecond: null };
const EMPTY_MAP_STATS = {
  itemRarity: null,
  packSize: null,
  monsterRarity: null,
  dropChance: null,
  monsterEffectiveness: null,
  revives: null
};

/**
 * Fills in the fields every row needs and none of the scene cares about. `rawText` matters more than
 * it looks: it is what the hover tooltip prints, so a row whose text doesn't match its mods reads as
 * a bug in the screenshot.
 */
function item(overrides) {
  return {
    id: overrides.id,
    rawText: "",
    rarity: "Currency",
    name: "",
    baseType: "",
    itemClass: null,
    stackSize: 1,
    itemLevel: null,
    quality: null,
    gemLevel: null,
    waystoneTier: null,
    socketCount: null,
    defences: EMPTY_DEFENCES,
    weapon: EMPTY_WEAPON,
    mapStats: EMPTY_MAP_STATS,
    identified: true,
    corrupted: false,
    mods: [],
    implicitMods: [],
    explicitMods: [],
    chaosValue: null,
    priceSource: "unpriced",
    ignoredMods: [],
    manualChaosValue: null,
    ...overrides
  };
}

/** Currency: one price source, one line of text, nothing to search. */
function currency(id, name, stackSize, chaosValue, minutesAgo) {
  return item({
    id,
    name,
    baseType: name,
    rarity: "Currency",
    stackSize,
    chaosValue,
    priceSource: "poeninja",
    capturedAt: NOW - minutesAgo * MINUTE,
    rawText: [
      "Item Class: Stackable Currency",
      "Rarity: Currency",
      name,
      "--------",
      `Stack Size: ${stackSize}/40`
    ].join("\n")
  });
}

const ITEMS = [
  currency("i-alch", "Orb of Alchemy", 21, 0.11, 103),
  currency("i-vaal", "Vaal Orb", 8, 0.28, 88),
  currency("i-jeweller", "Greater Jeweller's Orb", 1, 3.1, 74),
  currency("i-annul", "Orb of Annulment", 3, 2.4, 66),
  currency("i-chaos", "Chaos Orb", 37, 1, 52),

  // Magic: PoE2 glues the affixes onto the base type, so there is nothing to search on.
  item({
    id: "i-magic-ring",
    rarity: "Magic",
    name: "Stalwart Sapphire Ring of the Prism",
    baseType: "Sapphire Ring",
    itemClass: "accessory.ring",
    itemLevel: 68,
    priceSource: "unpriced",
    unpricedReason: "notSearchable",
    capturedAt: NOW - 15 * MINUTE,
    implicitMods: ["+25% to Cold Resistance"],
    explicitMods: ["+21 to Strength", "+13% to all Elemental Resistances"],
    rawText: [
      "Item Class: Rings",
      "Rarity: Magic",
      "Stalwart Sapphire Ring of the Prism",
      "--------",
      "Item Level: 68",
      "--------",
      "+25% to Cold Resistance (implicit)",
      "--------",
      "+21 to Strength",
      "+13% to all Elemental Resistances"
    ].join("\n")
  }),

  currency("i-divine", "Divine Orb", 2, 25, 33),

  // The market's own answer: searched, nothing listed. Repricing this changes nothing, which is the
  // distinction the badge colours carry.
  item({
    id: "i-gloves",
    rarity: "Rare",
    name: "Woe Grasp",
    baseType: "Feathered Gauntlets",
    itemClass: "armour.gloves",
    itemLevel: 72,
    defences: { armour: null, evasion: 218, energyShield: null, ward: null },
    priceSource: "unpriced",
    unpricedReason: "noListings",
    unpricedDetail:
      "The search ran and matched nothing: no instant-buyout listings for this class carrying both of its mods.",
    tradeSearchId: "sample",
    capturedAt: NOW - 12 * MINUTE,
    mods: [
      { text: "+18% to Chaos Resistance", kind: "explicit", tier: 4, rollRange: { min: 16, max: 20 } },
      { text: "22% increased Evasion Rating", kind: "explicit", tier: 5, rollRange: { min: 18, max: 25 } }
    ],
    explicitMods: ["+18% to Chaos Resistance", "22% increased Evasion Rating"],
    rawText: [
      "Item Class: Gloves",
      "Rarity: Rare",
      "Woe Grasp",
      "Feathered Gauntlets",
      "--------",
      "Evasion Rating: 218",
      "--------",
      "Item Level: 72",
      "--------",
      "+18% to Chaos Resistance",
      "22% increased Evasion Rating"
    ].join("\n")
  }),

  // A hand-typed price, which is what the row editor's bottom field writes.
  item({
    id: "i-wand",
    rarity: "Rare",
    name: "Vengeance Barb",
    baseType: "Attuned Wand",
    itemClass: "weapon.wand",
    itemLevel: 78,
    manualChaosValue: 8,
    priceSource: "unpriced",
    unpricedReason: "noListings",
    capturedAt: NOW - 24 * MINUTE,
    implicitMods: ["36% increased Lightning Damage"],
    explicitMods: ["+2 to Level of all Lightning Spell Skills", "+59 to maximum Mana"],
    rawText: [
      "Item Class: Wands",
      "Rarity: Rare",
      "Vengeance Barb",
      "Attuned Wand",
      "--------",
      "Item Level: 78",
      "--------",
      "36% increased Lightning Damage (implicit)",
      "--------",
      "+2 to Level of all Lightning Spell Skills",
      "+59 to maximum Mana"
    ].join("\n")
  }),

  // Priced off the currency exchange rather than poe.ninja, so the row's source badge differs.
  item({
    id: "i-waystone",
    rarity: "Normal",
    name: "Waystone of Deluge",
    baseType: "Waystone (Tier 15)",
    itemClass: "map",
    waystoneTier: 15,
    itemLevel: 80,
    mapStats: {
      itemRarity: 42,
      packSize: 18,
      monsterRarity: null,
      dropChance: 85,
      monsterEffectiveness: null,
      revives: null
    },
    chaosValue: 0.35,
    priceSource: "currencyExchange",
    capturedAt: NOW - 19 * MINUTE,
    rawText: [
      "Item Class: Waystones",
      "Rarity: Magic",
      "Waystone of Deluge",
      "Waystone (Tier 15)",
      "--------",
      "Waystone Tier: 15",
      "Waystone Drop Chance: +85%",
      "Item Rarity: +42%",
      "Pack Size: +18%",
      "--------",
      "Item Level: 80"
    ].join("\n")
  }),

  item({
    id: "i-astramentis",
    rarity: "Unique",
    name: "Astramentis",
    baseType: "Stellar Amulet",
    itemClass: "accessory.amulet",
    itemLevel: 74,
    chaosValue: 46.5,
    priceSource: "poeninja",
    capturedAt: NOW - 9 * MINUTE,
    implicitMods: ["+18 to Spirit"],
    explicitMods: ["+96 to all Attributes", "-4 to all Attributes"],
    rawText: [
      "Item Class: Amulets",
      "Rarity: Unique",
      "Astramentis",
      "Stellar Amulet",
      "--------",
      "Item Level: 74",
      "--------",
      "+18 to Spirit (implicit)",
      "--------",
      "+96 to all Attributes",
      "-4 to all Attributes"
    ].join("\n")
  }),

  // The rate-limited row: no search went out, and the value cell counts down against
  // `tradeCooldownUntil` in STATUS below.
  item({
    id: "i-ring",
    rarity: "Rare",
    name: "Corpse Loop",
    baseType: "Prismatic Ring",
    itemClass: "accessory.ring",
    itemLevel: 81,
    priceSource: "unpriced",
    unpricedReason: "rateLimited",
    unpricedDetail: "No trade search went out: the per-IP search budget was spent. Retry in ~272s.",
    capturedAt: NOW - 6 * MINUTE,
    mods: [
      { text: "+29% to Cold Resistance", kind: "explicit", tier: 3, rollRange: { min: 26, max: 35 } },
      { text: "+41 to maximum Mana", kind: "explicit", tier: 5, rollRange: { min: 35, max: 44 } }
    ],
    implicitMods: ["+8% to all Elemental Resistances"],
    explicitMods: ["+29% to Cold Resistance", "+41 to maximum Mana"],
    rawText: [
      "Item Class: Rings",
      "Rarity: Rare",
      "Corpse Loop",
      "Prismatic Ring",
      "--------",
      "Item Level: 81",
      "--------",
      "+8% to all Elemental Resistances (implicit)",
      "--------",
      "+29% to Cold Resistance",
      "+41 to maximum Mana"
    ].join("\n")
  }),

  // The relaxed trade price: four mods offered, three searched. Carries the listing date, so the row
  // draws its "(listed 3d ago)" parenthetical, and a sample so the editor can say how thin the floor
  // is.
  item({
    id: "i-cuirass",
    rarity: "Rare",
    name: "Damnation Shell",
    baseType: "Soldier Cuirass",
    itemClass: "armour.chest",
    itemLevel: 79,
    quality: 20,
    socketCount: 2,
    defences: { armour: 1081, evasion: null, energyShield: null, ward: null },
    chaosValue: 0.75,
    priceSource: "trade2",
    modMatch: { matched: 3, total: 4 },
    tradeListingIndexedAt: NOW - 3 * DAY,
    tradeListingQuote: { amount: 12, currency: "exalted" },
    tradeListingSample: [
      { chaos: 0.75, indexedAt: NOW - 3 * DAY },
      { chaos: 0.81, indexedAt: NOW - 19 * HOUR },
      { chaos: 0.94, indexedAt: NOW - 2 * DAY },
      { chaos: 1.06, indexedAt: NOW - 6 * HOUR },
      { chaos: 1.38, indexedAt: NOW - 11 * HOUR }
    ],
    tradeSearchId: "sample",
    autoDroppedMods: ["+12 to Strength"],
    searchedMods: [
      "+186 to maximum Life",
      "+31% to Fire Resistance",
      "+24% to Lightning Resistance"
    ],
    capturedAt: NOW - 4 * MINUTE,
    mods: [
      { text: "+186 to maximum Life", kind: "explicit", tier: 2, rollRange: { min: 160, max: 199 } },
      { text: "+31% to Fire Resistance", kind: "explicit", tier: 3, rollRange: { min: 26, max: 35 } },
      { text: "+24% to Lightning Resistance", kind: "explicit", tier: 4, rollRange: { min: 21, max: 25 } },
      { text: "+12 to Strength", kind: "explicit", tier: 6, rollRange: { min: 9, max: 12 } }
    ],
    explicitMods: [
      "+186 to maximum Life",
      "+31% to Fire Resistance",
      "+24% to Lightning Resistance",
      "+12 to Strength"
    ],
    rawText: [
      "Item Class: Body Armours",
      "Rarity: Rare",
      "Damnation Shell",
      "Soldier Cuirass",
      "--------",
      "Quality: +20% (augmented)",
      "Armour: 1081 (augmented)",
      "--------",
      "Requirements:",
      "Level: 65",
      "Str: 122",
      "--------",
      "Sockets: S S",
      "--------",
      "Item Level: 79",
      "--------",
      "+186 to maximum Life",
      "+31% to Fire Resistance",
      "+24% to Lightning Resistance",
      "+12 to Strength"
    ].join("\n")
  }),

  currency("i-exalted", "Exalted Orb", 14, 0.062, 1)
];

/** Everything the header reads: the rates, the price age and the live trade cooldown. */
const STATUS = {
  rates: { chaosPerDivine: 25, exaltedPerDivine: 400 },
  pricesFetchedAt: NOW - 4 * MINUTE,
  tradeCooldownUntil: NOW + 4 * MINUTE + 32_000,
  displayCurrency: "auto",
  interactive: true,
  expanded: true,
  panel: { width: 380, maxHeightPercent: 80, position: "right" },
  update: null
};

/** What `getEditorRows` answers with — the aggregate rows and the floors the search would use. */
const EDITOR_ROWS = {
  pseudoStats: [
    {
      id: "pseudo.pseudo_total_elemental_resistance",
      label: "Total Elemental Resistance",
      contributors: [
        { text: "+31% to Fire Resistance", amount: 31, tier: 3 },
        { text: "+24% to Lightning Resistance", amount: 24, tier: 4 }
      ],
      minContributors: 2
    }
  ],
  pseudoMinRatio: 0.9,
  modFloors: [
    { text: "+186 to maximum Life", min: 160 },
    { text: "+31% to Fire Resistance", min: 26 },
    { text: "+24% to Lightning Resistance", min: 21 },
    { text: "+12 to Strength", min: 9 }
  ],
  mapRows: [],
  mapMinRatio: 0.9
};

/**
 * The two framed windows' own state. The league is generic and the email blank on purpose: this file
 * is public and a screenshot is an easy place to leak either by accident.
 */
const SETUP_STATE = { league: "Standard", contactEmail: "", setupCompleted: true };

const SETTINGS_CONFIG = {
  hotkeys: { toggleList: "Control+Shift+L", forceCapture: "Control+`" },
  overlay: {
    hideWhenGameUnfocused: true,
    hideDelayMs: 500,
    panel: { width: 380, maxHeightPercent: 80, position: "right" }
  },
  display: { currency: "auto" },
  trade2: { saleType: "buyout", listingStatus: "securable", useMapFilters: true, mapMinRatio: 0.9 }
};

const SETTINGS_STATE = {
  ...SETTINGS_CONFIG,
  defaults: JSON.parse(JSON.stringify(SETTINGS_CONFIG))
};

module.exports = { NOW, ITEMS, STATUS, EDITOR_ROWS, SETUP_STATE, SETTINGS_STATE };
