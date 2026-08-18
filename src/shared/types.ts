export type ItemRarity = "Normal" | "Magic" | "Rare" | "Unique" | "Currency" | "Gem";

/**
 * Where a mod line came from. GGG's trade stat reference is partitioned into groups with the same
 * names, and the partition is load-bearing rather than cosmetic: by display text alone `crafted`,
 * `fractured` and `desecrated` are 100% subsets of `explicit` and `enchant` is 99%, so a stat id
 * picked without knowing the kind is a coin flip that produces a filter for the wrong thing.
 */
export type ModKind =
  | "implicit"
  | "explicit"
  | "rune"
  | "enchant"
  | "crafted"
  | "fractured"
  | "desecrated";

export interface ParsedMod {
  /** Display text with roll ranges and the trailing kind marker removed. */
  text: string;
  kind: ModKind;
  /**
   * The affix tier out of the `(Tier: N)` in an Advanced Item Descriptions header, where **1 is the
   * best roll** and larger numbers are worse. Null when the header carried no tier, and `undefined`
   * on items captured before this was parsed — `loot-cache.json` has no migration, which is the same
   * reason `modsOf()` exists. Both read as "unknown", and unknown is never treated as droppable by
   * `droppableFilters()`, so the absence can only cost specificity, never invent it.
   *
   * PoE2 prints this only when the player has Advanced Item Descriptions switched on, so an item
   * whose mods all have no tier is the ordinary case rather than a parse failure.
   */
  tier?: number | null;
}

/**
 * One of GGG's synthetic aggregate stats, derived from the item's real mods rather than matched
 * against its text — "83% total Elemental Resistance" from three separate resistance rolls.
 *
 * The market prices the total, and GGG indexes it, so searching the aggregate finds comparables that
 * searching the three pinned rolls never would. Derived in `shared/pseudo-stats.ts`.
 */
export interface PseudoStat {
  /** GGG's pseudo stat id, e.g. `pseudo.pseudo_total_elemental_resistance`. */
  id: string;
  /** Human wording for the row editor and the reprice status line. */
  label: string;
  /**
   * The mod lines feeding this aggregate and what each adds. Kept rather than pre-summed because the
   * editor lets the user untick contributors, and the total has to follow.
   */
  contributors: Array<{ text: string; amount: number }>;
}

/**
 * A numeric range the user set for one mod line in the row editor, used in place of the roll the
 * item actually has when building that mod's trade2 stat filter.
 *
 * The search otherwise pins every stat to the item's own number, which is what makes a good item
 * match only strictly better ones. This is the per-stat equivalent of what `defenceMinRatio` does
 * for armour totals, except chosen by hand rather than by a global ratio.
 */
export interface ModFilter {
  /** The mod's exact display text — the same key `ignoredMods` matches on. */
  text: string;
  /** Lower bound, or null to search this stat by presence alone. */
  min: number | null;
  /** Upper bound, or null for no ceiling — which is what every search sent before this existed. */
  max: number | null;
}

/**
 * The defence totals PoE2 prints in an item's property block. Each is the *finished* number, with
 * every local defence mod and the item's current quality already applied by the game — which is why
 * these are searched directly instead of the mods behind them. null for a defence the item lacks.
 *
 * Read through `defencesOf()` (`shared/defences.ts`), never off the field: nothing migrates
 * `loot-cache.json`, so items captured before this existed have no `defences` key at all.
 */
export interface ItemDefences {
  /** `Armour: N`. */
  armour: number | null;
  /** `Evasion Rating: N`. */
  evasion: number | null;
  /** `Energy Shield: N`. */
  energyShield: number | null;
  /** `Runic Ward: N`, which runeforged bases carry in place of energy shield. */
  ward: number | null;
}

/**
 * The reward totals PoE2 prints on a waystone's property block. Each is the *finished* number the
 * game shows, produced collectively by the affix set rather than by any one mod — which is why these
 * are searched directly and the affixes are not.
 *
 * Read through `mapStatsOf()` (`shared/map-stats.ts`), never off the field: nothing migrates
 * `loot-cache.json`, so a waystone captured before this existed has no `mapStats` key at all.
 */
export interface ItemMapStats {
  /** `Item Rarity: +24%`. GGG indexes it as `map_iir`. */
  itemRarity: number | null;
  /** `Pack Size: +7%` — the trade site calls the same filter "Waystone Packsize". */
  packSize: number | null;
  /** `Monster Rarity: +18%`. */
  monsterRarity: number | null;
  /** `Waystone Drop Chance: +85%`. */
  dropChance: number | null;
  /** `Monster Effectiveness: +13%`. Parsed but not filtered on — see `buildMapFilters`. */
  monsterEffectiveness: number | null;
  /** `Revives Available: 0`. Parsed but not filtered on, for the same reason. */
  revives: number | null;
}

/** One of a waystone's reward totals as the search and the row editor both see it. */
export interface MapRow {
  /** GGG's `map_filters` id. Also the key a user-set bound is stored under. */
  id: string;
  label: string;
  /** The waystone's own printed value, before any floor ratio is applied. */
  value: number;
}

export interface ParsedItem {
  rawText: string;
  rarity: ItemRarity;
  name: string;
  /**
   * For Magic items this is the affixed header line ("Sharp Titan Gauntlets of Fire"), not a real
   * base — PoE2 glues prefix and suffix onto the base on a single line and there's no base-type
   * table here to strip them with. Route Magic items by `itemClass` instead.
   */
  baseType: string;
  /**
   * The `Item Class:` header line ("Waystones", "Stackable Currency", "Skill Gems"). The only
   * reliable category signal in the clipboard text — `rarity` and `baseType` can't distinguish a
   * waystone from a tablet. null when the game omits the line (older clients).
   */
  itemClass: string | null;
  stackSize: number;
  /** `Item Level: N`. What an uncut skill gem is actually priced on. */
  itemLevel: number | null;
  /** `Quality: +N%`, without the sign. */
  quality: number | null;
  /** A gem's own `Level: N` line, distinct from `Item Level:` and `Requires Level`. */
  gemLevel: number | null;
  /** `Waystone Tier: N`. The tier also appears inside the name string, but only as text. */
  waystoneTier: number | null;
  /** Number of rune/soul-core sockets from the `Sockets:` line. */
  socketCount: number | null;
  /**
   * Armour/evasion/energy shield/ward from the property block. These are what GGG's trade
   * `equipment_filters` index, so a rare armour is searched on its totals rather than on the exact
   * rolls of the mods that produced them — see `shared/defences.ts`.
   */
  defences: ItemDefences;
  /**
   * A waystone's printed reward totals, all null for anything that isn't one. These are what GGG's
   * `map_filters` group indexes, and what a waystone is actually traded on — see `shared/map-stats.ts`.
   */
  mapStats: ItemMapStats;
  identified: boolean;
  corrupted: boolean;
  /**
   * Every affix line with the group it came from. This is the authoritative list — the two arrays
   * below are flattened views of it, kept because they are what `loot-cache.json` already stores,
   * what the row editor renders, and what `ignoredMods` holds text from. Read mods through
   * `modsOf()` rather than this field directly, so items persisted before it existed still work.
   */
  mods: ParsedMod[];
  implicitMods: string[];
  /** Everything that isn't implicit, flattened — including rune, crafted and fractured lines. */
  explicitMods: string[];
  capturedAt: number;
}

export interface PricedItem extends ParsedItem {
  id: string;
  sessionId: string;
  chaosValue: number | null;
  priceSource: "poeninja" | "currencyExchange" | "trade2" | "unpriced";
  /** Mod lines (exact text) excluded from the trade2 search when this item was last (re)priced. */
  ignoredMods: string[];
  /**
   * Per-mod bounds the user set in the row editor, applied in place of the mod's own roll.
   *
   * Optional because nothing migrates `loot-cache.json` — absent means "use each mod's own roll",
   * which is what the search did before this existed, not "the user cleared every bound".
   */
  modFilters?: ModFilter[];
  /**
   * Bounds for the derived pseudo aggregates, keyed by pseudo stat id in `ModFilter.text`.
   *
   * Separate from `modFilters` because the two are keyed by different things and a pseudo id is not
   * a mod line. Optional for the same reason everything else here is — absent means "search each
   * aggregate at the item's own total".
   */
  pseudoFilters?: ModFilter[];
  /** Bounds for a waystone's reward totals, keyed by `map_filters` id in `ModFilter.text`. */
  mapFilters?: ModFilter[];
  /** User-entered override; takes precedence over chaosValue when set. See effectiveChaosValue(). */
  manualChaosValue: number | null;
  /**
   * The median of the same sampled listings `chaosValue` is the cheapest of — shown in parentheses
   * beside the price so a floor propped up by one optimistic seller is visible as one.
   *
   * Named apart from `manualChaosValue` deliberately: that one *replaces* the price, this one only
   * annotates it, and nothing should ever read this as a value the item is worth. Optional for the
   * same reason as `tradeSearchId` — nothing migrates `loot-cache.json`, and only trade2-priced
   * items ever set it.
   */
  tradeMedianChaosValue?: number;
  /**
   * How specific the trade2 search behind `chaosValue` was: `{ matched: 3, total: 4 }` means no
   * listing carried all four of this item's mods, so the price came from ones sharing three.
   *
   * Optional because nothing migrates `loot-cache.json` and only trade2-priced items ever set it —
   * treat its absence as "not applicable", not as "matched everything".
   */
  modMatch?: { matched: number; total: number };
  /**
   * GGG's id for the trade2 search `chaosValue` came from, which `tradeSearchUrl` turns into a link
   * to that same query on the trade site.
   *
   * Optional for the same reason as `modMatch`, and additionally **perishable**: GGG expires search
   * ids, so a stored one is a lead rather than a guarantee. Anything offering it as a link has to
   * cope with the search no longer being there.
   */
  tradeSearchId?: string;
  /**
   * The trade2 search found nothing at this item's own defence totals and was retried without that
   * constraint, so `chaosValue` compares this base and these mods at *any* Armour/Evasion/ES.
   *
   * Optional for the same reason as `modMatch` — absent means "not applicable", not "false".
   */
  defencesDropped?: boolean;
  /**
   * Nothing matched with the derived pseudo aggregates applied, so the search was retried without
   * them and `chaosValue` compares this base and these mods at any resistance/life total.
   *
   * Optional for the same reason as `defencesDropped`.
   */
  pseudoDropped?: boolean;
  /**
   * A waystone's reward floors matched nothing, so its price came from base type alone — meaning
   * every other waystone of this tier, since a waystone's affixes are never searched.
   *
   * Optional for the same reason as `defencesDropped`.
   */
  mapDropped?: boolean;
  /**
   * How many of the sampled listings carried each mod, and how many were sampled.
   *
   * This is *not* "the mods the search used". A `count` search asks for at least N of M and different
   * listings satisfy different subsets, so there is no such set — only how often each mod turned up
   * among the listings the price was taken from. Optional, and only trade2-priced items have it.
   */
  statCoverage?: Array<{ text: string; listings: number }>;
  coverageSample?: number;
  /**
   * The mod lines the tier ladder removed by itself to find a market — the low-tier affixes that were
   * pinning the search to an item nobody has listed. See `droppableFilters()`.
   *
   * **Kept apart from `ignoredMods` deliberately.** That field is the user's decision, recorded from
   * the row editor's checkboxes and re-sent on the next Reprice; this one is the app's, recomputed
   * from scratch by every search. Folding them together would make an automatic guess indistinguish-
   * able from a deliberate exclusion and permanent by accident. It's the same separation
   * `tradeMedianChaosValue` has from `manualChaosValue`: one annotates the price, the other replaces
   * it.
   *
   * The editor unticks these rows so the mods that produced the price come back selected, and marks
   * them so the state still reads as the app's choice. Optional — nothing migrates `loot-cache.json`,
   * and an item priced off a `count` rung legitimately has none.
   */
  autoDroppedMods?: string[];
}

export interface Session {
  id: string;
  league: string;
  startedAt: number;
  endedAt: number | null;
  zoneName: string | null;
  totalChaosValue: number;
  /**
   * Opened by the toggle-session hotkey, i.e. the user saying "treat this as a map" when zone
   * detection can't.
   *
   * Exists to tell the *three* things that open a `zoneName: null` session apart, which used to be
   * two indistinguishable ones. A zone transition supplies a name; the hotkey sets this; and
   * `ensureActiveSession` opens one from a bare capture, which is neither — see `isMapSession`.
   *
   * Optional because nothing migrates `loot-cache.json`; a session written before this existed reads
   * as `undefined`, which is correctly falsy.
   */
  manual?: boolean;
}

/** Transient zone-change signal pushed to the renderer; not persisted. */
export interface ZoneStatus {
  zoneName: string;
  isHideout: boolean;
}

/**
 * How far a captured item has got before it has a price.
 *
 * `pricing` is almost never seen: poe.ninja and the currency exchange are synchronous cache lookups,
 * so anything they can price passes through it in microseconds. Only a Rare that misses both reaches
 * `trade2`, and only that stage takes long enough to be worth showing.
 */
export type PendingStage = "queued" | "pricing" | "trade2";

/**
 * A capture that doesn't have a price yet. `PricingQueue` owns the list and pushes it whole on every
 * transition, so the renderer never has to match a pending row against the `PricedItem` that
 * eventually replaces it.
 *
 * Not persisted, and deliberately not a `PricedItem` — see the note in `renderPending` for why these
 * are kept out of the item list entirely.
 */
export interface PendingCapture {
  /** Minted at enqueue. A DOM key for the renderer; unrelated to the eventual `PricedItem.id`. */
  id: string;
  /**
   * The whole parsed item, not a subset — it costs nothing at these list lengths and lets the pending
   * row reuse the same name/subtitle/tooltip builders the priced rows use.
   */
  item: ParsedItem;
  stage: PendingStage;
}

/**
 * Panel-wide state that isn't tied to a single item or session. Pushed on change and fetchable on
 * load, so the renderer never has to guess at any of it.
 */
export interface OverlayStatus {
  /** null until poe.ninja first answers — the renderer then shows raw chaos rather than converting. */
  rates: { chaosPerDivine: number; exaltedPerDivine: number } | null;
  /** Epoch ms of the last successful price refresh, for the "prices Nm old" line. */
  pricesFetchedAt: number | null;
  displayCurrency: "auto" | "exalted" | "chaos" | "divine";
  /**
   * Whether the overlay currently accepts clicks. In click-through mode the buttons are inert but
   * looked identical, so there was no way to tell the panel was ignoring you.
   */
  interactive: boolean;
  /**
   * Whether the panel is showing the full list rather than its minimal form.
   *
   * The panel rests as a heads-up display — the last capture and nothing else — and this is the only
   * thing that opens it. Driven purely by the `toggleList` hotkey, so unlike the map total it needs
   * no grace period: a keypress is deliberate and should apply the instant it arrives.
   */
  expanded: boolean;
  /**
   * Panel size and side from `overlay.panel`. The size is applied as inline style — the list is the
   * whole panel now — and the side as a class, since it carries no number of its own.
   */
  panel: { width: number; maxHeightPercent: number; position: "left" | "right" };
}

/**
 * The three values every install has to supply for itself, shown in the first-run setup window.
 * They can't ship as usable defaults: `league` rotates every few months, and the other two are the
 * machine's and the player's own.
 */
export interface SetupConfig {
  league: string;
  /** Optional. Sent in the User-Agent on GGG requests; blank simply omits the contact clause. */
  contactEmail: string;
  clientTxtPath: string;
}

/** `SetupConfig` plus what the window needs to explain itself before the user has chosen anything. */
export interface SetupState extends SetupConfig {
  /**
   * What Steam detection found, or null. Separate from `clientTxtPath` so the form can say "found
   * in your Steam library" about a prefilled value rather than presenting it as an existing choice.
   */
  detectedClientTxtPath: string | null;
  /** False on the very first run, which is what makes the window appear unprompted. */
  setupCompleted: boolean;
}

/**
 * The settings window's fields — deliberately *not* the whole `Settings` shape.
 *
 * What's here is exactly what can be applied without restarting: nothing downstream captured any of
 * it, unlike `league`, which three pricing clients each read at construction. `SetupConfig` holds
 * that other half. `overlay.focusPollIntervalMs` is left out on purpose — it trades CPU against how
 * quickly the overlay reacts to alt-tab, which is a tuning knob rather than a preference.
 */
export interface SettingsConfig {
  hotkeys: {
    toggleOverlay: string;
    toggleList: string;
    toggleSession: string;
    forceCapture: string;
  };
  overlay: {
    hideWhenGameUnfocused: boolean;
    hideDelayMs: number;
    panel: { width: number; maxHeightPercent: number; position: "left" | "right" };
  };
  display: { currency: "auto" | "exalted" | "chaos" | "divine" };
  /**
   * The one trade2 key the window may edit. It qualifies on the same test as everything above:
   * `Trade2Client` reads `this.settings.trade2.saleType` when it builds each query, so mutating it
   * applies to the very next lookup. Its neighbours in that block mostly do *not* — `contactEmail`
   * is baked into the User-Agent by `createPublicGggFetch` and the budget numbers are captured by
   * `TradeSearchBudget`, both at construction — so don't widen this to them without checking.
   */
  trade2: { saleType: "buyout" | "any" };
}

/** `SettingsConfig` plus the shipped defaults, which back the per-field Reset buttons. */
export interface SettingsState extends SettingsConfig {
  defaults: SettingsConfig;
}

/**
 * Why a save didn't fully take. Both lists empty means everything applied.
 *
 * The two are different kinds of problem and read differently to the user: `invalid` is a combo that
 * could never work and nothing was written, while `refused` was written and simply isn't available
 * right now — closing whichever app holds it is enough to make it start working.
 */
export interface SettingsSaveResult {
  invalid: Array<{ name: string; accelerator: string; reason: string }>;
  refused: Array<{ name: string; accelerator: string }>;
}
