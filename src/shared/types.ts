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
  /** User-entered override; takes precedence over chaosValue when set. See effectiveChaosValue(). */
  manualChaosValue: number | null;
  /**
   * How specific the trade2 search behind `chaosValue` was: `{ matched: 3, total: 4 }` means no
   * listing carried all four of this item's mods, so the price came from ones sharing three.
   *
   * Optional because nothing migrates `loot-cache.json` and only trade2-priced items ever set it —
   * treat its absence as "not applicable", not as "matched everything".
   */
  modMatch?: { matched: number; total: number };
  /**
   * The trade2 search found nothing at this item's own defence totals and was retried without that
   * constraint, so `chaosValue` compares this base and these mods at *any* Armour/Evasion/ES.
   *
   * Optional for the same reason as `modMatch` — absent means "not applicable", not "false".
   */
  defencesDropped?: boolean;
}

export interface Session {
  id: string;
  league: string;
  startedAt: number;
  endedAt: number | null;
  zoneName: string | null;
  totalChaosValue: number;
}

/** Transient zone-change signal pushed to the renderer; not persisted. */
export interface ZoneStatus {
  zoneName: string;
  isHideout: boolean;
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
  /** Panel size from `overlay.panel`, applied as inline style — the list is the whole panel now. */
  panel: { width: number; maxHeightPercent: number };
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
