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
  /**
   * The roll bracket printed around this mod's first number — `16(6-16)%` gives `{ min: 6, max: 16 }`.
   *
   * What separates "rolled the top of its bracket" from "rolled the bottom", which the roll alone
   * cannot say. `searchFloor()` (`shared/mod-rolls.ts`) turns it into the number the search asks for,
   * so a 16-of-16 and a 6-of-16 are not both demanded exactly.
   *
   * Null when the game printed no bracket and `undefined` on items captured before it was parsed —
   * both read as "unknown", and both fall back to flooring at the item's own roll, which is what
   * every search did before. Same degraded-not-disabled arrangement as `tier`.
   */
  rollRange?: { min: number; max: number } | null;
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
   *
   * `tier` is the contributing affix's own tier, carried through from `ParsedMod.tier` and read the
   * same way — null when the game printed none, `undefined` on an item captured before it was
   * parsed. The editor badges them onto the aggregate row, because a total says nothing about
   * whether it is one excellent roll or three mediocre ones.
   */
  contributors: Array<{ text: string; amount: number; tier?: number | null }>;
  /**
   * How many ticked contributors this aggregate needs before it is worth deriving — two for most,
   * one for the single-element resistance totals (see `chooseResistanceAggregate`).
   *
   * It rides along for the same reason `pseudoMinRatio` does: the row editor has to grey out an
   * aggregate the next search would no longer derive, and it is a plain `<script>` that cannot import
   * `shared/pseudo-stats.ts` at runtime. A renderer-side copy of the rule would silently disagree the
   * first time the table changed.
   */
  minContributors: number;
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
 * The two numbers a weapon's property block carries that multiply into elemental DPS.
 *
 * Kept apart from `ItemDefences` because they are not a total but the factors of one: GGG's
 * `equipment_filters.edps` is damage per hit times attacks per second, and neither half is a filter
 * on its own. Both are already finished numbers — every `Adds # to # Fire Damage` roll on the item
 * is inside the printed damage, exactly as local defence mods are inside `Armour:`.
 *
 * Read through `weaponStatsOf()` (`shared/weapon-stats.ts`), never off the field: nothing migrates
 * `loot-cache.json`, so items captured before this existed have no `weapon` key at all.
 */
export interface ItemWeaponStats {
  /**
   * Summed average of every range on the `Elemental Damage:` line — 12-25 contributes 18.5. One line
   * can carry a range per element, which is why this is a single total rather than three fields:
   * eDPS makes no distinction between them.
   */
  elementalDamage: number | null;
  /** `Attacks per Second: 1.55`. */
  attacksPerSecond: number | null;
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
  /**
   * `Monster Effectiveness: +13%`. GGG indexes it as `map_magic_monsters` — the id reads like magic
   * monster quantity but `/api/trade2/data/filters` titles it "Monster Effectiveness", confirmed live.
   */
  monsterEffectiveness: number | null;
  /** `Revives Available: 0`. GGG's `map_revives`, searched as a floor — more revives is a benefit. */
  revives: number | null;
}

/** One of a waystone's printed totals as the search and the row editor both see it. */
export interface MapRow {
  /** GGG's `map_filters` id. Also the key a user-set bound is stored under. */
  id: string;
  label: string;
  /** The waystone's own printed value, before the ratio is applied. Searched as a floor. */
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
   * A weapon's elemental damage and attack rate, all null for anything that isn't one. Their product
   * is the elemental DPS GGG indexes as `equipment_filters.edps` — see `shared/weapon-stats.ts`.
   */
  weapon: ItemWeaponStats;
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

/**
 * Why a trade lookup produced no value, in the terms the user has to act on. Each member asks for
 * something different: wait, change a setting, look at the trade site by hand, or nothing at all.
 *
 * Deliberately a closed set rather than free text, and deliberately not derived from
 * `TradeEstimate.reason` — that string is user-facing prose that gets reworded, and several call
 * sites produce the same kind sharing no wording. Lives here rather than in `trade2-client.ts` so
 * `UnpricedReason` can build on it without `shared/` importing from `pricing/`.
 */
export type TradeFailure =
  /** The budget declined the search, the ladder ran out of slots, or GGG answered 429. Waiting fixes it. */
  | "rateLimited"
  /** No search was ever sent: trade2 off, base search off, or the item level below the floor. */
  | "notSearched"
  /** Searched, and the market has nothing — no match, or nothing at or above the price floor. */
  | "noListings"
  /** Listings exist, but none quoted a currency this app could convert to chaos. */
  | "unconvertible"
  /** The search went out and broke: an HTTP error, a thrown fetch, or retries exhausted. */
  | "searchFailed";

/**
 * Why an item has no price — every trade failure, plus the three situations that never reach trade2
 * at all. `PriceResolver.explainUnpriced` is the one place that decides which of these applies.
 */
export type UnpricedReason =
  | TradeFailure
  /** poe.ninja's first refresh is still in flight, so nothing could be looked up yet. */
  | "pricesLoading"
  /** A Magic item: PoE2 glues its affixes onto the base type, leaving nothing to search on. */
  | "notSearchable"
  /** Not in poe.ninja's data and not traded on the currency exchange. */
  | "noPriceData";

export interface PricedItem extends ParsedItem {
  id: string;
  chaosValue: number | null;
  priceSource: "poeninja" | "currencyExchange" | "trade2" | "unpriced";
  /**
   * Why an unpriced item is unpriced, as the closed set of situations the row can tell apart.
   *
   * Deliberately **not** a fifth `priceSource` — that field says where a price *came from*, and none
   * of these is a source. It is what turns one word covering seven situations into a badge that says
   * which: `"rateLimited"` and `"pricesLoading"` resolve on their own, `"notSearched"` wants a
   * setting changed, `"noListings"` and `"notSearchable"` are facts about the item that no amount of
   * retrying will change, and `"searchFailed"` is a fault worth seeing.
   *
   * Set by both write paths — `PriceResolver.resolve()` and `REPRICE_ITEM` — and *cleared* by the
   * second, which is why that one writes it outside its priced-only conditional.
   *
   * Optional and never migrated, like everything else here. Absent means "no price, and nothing more
   * to say about it", which is how every item stored before this existed reads — the honest fallback,
   * since a reason that old has long since stopped describing anything.
   */
  unpricedReason?: UnpricedReason;
  /**
   * The full sentence behind `unpricedReason`, shown on the badge's tooltip.
   *
   * The code above picks the badge word and is stable; this is the item-specific half that makes it
   * useful — which poe.ninja ids were tried, how many mods had no listing between them, how many
   * seconds until the budget refills. It is the same string the `[pricing] "…" unpriced — …` log line
   * prints, produced once and reused verbatim rather than reworded per surface.
   *
   * Optional and never migrated. Absent means the badge shows its own generic sentence and no more.
   */
  unpricedDetail?: string;
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
  /** User-entered override; takes precedence over chaosValue when set. See `effectiveValue()` in renderer/common.ts. */
  manualChaosValue: number | null;
  /**
   * When the cheapest sampled listing was posted, as epoch ms — shown in parentheses beside the
   * price, so how *old* the floor is stands next to what it is. The same number three days stale and
   * an hour fresh are different facts, and the price alone cannot say which.
   *
   * Never read it as a value; it annotates the price rather than replacing it, which is the same
   * separation `tradeListingQuote` has. Optional for the usual two reasons — nothing migrates
   * `loot-cache.json`, so items priced before this existed have none, and a listing whose date GGG
   * didn't send or that wouldn't parse deliberately stores none rather than a guess. The row draws
   * no parenthetical at all in either case.
   */
  tradeListingIndexedAt?: number;
  /**
   * Every sampled listing the price was reduced from — its chaos value, and when it was posted.
   *
   * `chaosValue` is the cheapest of these, which is the floor by specification. Keeping the rest is
   * what lets the row editor say how *thin* that floor is: a price off one listing and a price off ten
   * look identical once nine are thrown away, which is exactly what removing the median cost. This
   * restores the signal without putting a second number back on the row.
   *
   * The listings are the cheapest handful of a price-ascending search, so this is the market's left
   * tail rather than its distribution — never average it and call the result a value. `suggestSellRange`
   * is the only thing that reads it, and says so at length.
   *
   * Optional for the usual reason: nothing migrates `loot-cache.json`, so every item priced before this
   * existed has only the cheapest listing, and only a trade2-priced item ever has listings at all. Its
   * absence means "no record", never "one listing".
   */
  tradeListingSample?: Array<{ chaos: number; indexedAt?: number }>;
  /**
   * What the cheapest sampled listing was actually asking — `{ amount: 2, currency: "chaos" }`.
   *
   * Kept for **display only**, and only to choose a unit: a row whose price came from a seller
   * asking 2 chaos reads "2c" rather than the same value restated as 66ex, which is what the market
   * is quoting and what you would type into the trade site. The number shown is still converted from
   * `chaosValue`, so nothing here can drift from the totals — see `pickDisplayUnit`.
   *
   * Never read it as a value. Chaos is the storage unit throughout and this is a label on one, in the
   * same way `tradeListingIndexedAt` annotates rather than replaces. Optional for the usual reason:
   * nothing migrates `loot-cache.json`, and only a trade2-priced item ever has a listing behind it.
   */
  tradeListingQuote?: { amount: number; currency: string };
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
   * `tradeListingIndexedAt` has from `manualChaosValue`: one annotates the price, the other replaces
   * it.
   *
   * The editor unticks these rows so the mods that produced the price come back selected, and marks
   * them so the state still reads as the app's choice. Optional — nothing migrates `loot-cache.json`,
   * and an item priced off a `count` rung legitimately has none.
   */
  autoDroppedMods?: string[];
  /**
   * Every mod line that constrained the search this price came from — its own stat filter, a pseudo
   * aggregate that was applied, or an equipment defence floor that was applied.
   *
   * This is what the row editor ticks. Before it existed the editor ticked everything except
   * `ignoredMods` and `autoDroppedMods`, which overstated the search: a mod GGG's stat reference has
   * no template for never reaches the query at all, yet read as one the price rested on.
   *
   * **`undefined` means "no record", never "nothing was searched"** — nothing migrates
   * `loot-cache.json`, and items priced by poe.ninja or the exchange never ran a search to record.
   * The editor must fall back to its previous behaviour on absence rather than unticking every row.
   *
   * Distinct from `statCoverage` in the direction it measures, and the distinction is why both
   * exist: this names what the query **asked for**, which is known exactly; `statCoverage` counts
   * what the returned listings **carried**, which on a `count` rung names no set at all.
   */
  searchedMods?: string[];
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
  /**
   * Epoch ms at which a trade2 search could next go out, or null when one could go now.
   *
   * **An absolute deadline, not a remaining duration**, so the renderer counts down against its own
   * clock rather than against whatever the number was when it was sent. A duration would freeze
   * between pushes, which is precisely the staleness this exists to fix — the "retry in ~Ns" baked
   * into an item's `unpricedDetail` is exactly that frozen string, and the two must not be confused.
   * Both processes share one machine clock, so there is no skew to correct for.
   *
   * Null rather than 0 for "nothing to wait for", so the panel has one value to test rather than a
   * deadline sitting in the past. The countdown is ticked entirely in the renderer: pushing it per
   * second would rebuild the whole list every second, since `applyStatus` ends in `scheduleRender`.
   */
  tradeCooldownUntil: number | null;
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
  /**
   * A GitHub release newer than the running version, or null — from `main/update-check.ts`.
   *
   * Rides this push rather than getting a channel of its own because it is exactly what the rest of
   * this interface is: panel-wide state that isn't per-item, which the renderer reapplies wholesale
   * on every arrival. Null until the first check answers, which is also what a current install looks
   * like — the header line stays hidden for both, since there is nothing to say either way.
   */
  update: { version: string; url: string } | null;
}

/**
 * The two values every install has to supply for itself, shown in the first-run setup window.
 * They can't ship as usable defaults: `league` rotates every few months, and the contact address is
 * the player's own.
 */
export interface SetupConfig {
  league: string;
  /** Optional. Sent in the User-Agent on GGG requests; blank simply omits the contact clause. */
  contactEmail: string;
}

/** `SetupConfig` plus what the window needs to explain itself before the user has chosen anything. */
export interface SetupState extends SetupConfig {
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
    forceCapture: string;
  };
  overlay: {
    hideWhenGameUnfocused: boolean;
    hideDelayMs: number;
    panel: { width: number; maxHeightPercent: number; position: "left" | "right" };
  };
  display: { currency: "auto" | "exalted" | "chaos" | "divine" };
  /**
   * The four trade2 keys the window may edit. All qualify on the same test as everything above:
   * `Trade2Client` reads them off `this.settings.trade2` while building each query — `saleType` and
   * `listingStatus` in `searchRung`, `useMapFilters` and `mapMinRatio` in `buildMapFilters` — so
   * mutating any of them applies to the very next lookup. Their neighbours in that block mostly do
   * *not* — `contactEmail` is baked into the User-Agent by `createPublicGggFetch` and the budget
   * numbers are captured by `TradeSearchBudget`, both at construction — so don't widen this to them
   * without checking.
   *
   * `listingStatus` is spelled out here rather than imported as `ListingStatus` from
   * `pricing/trade2-client`, matching `saleType` and keeping this shared type free of a dependency
   * on the pricing layer. The five options and what each means are documented on
   * `Settings["trade2"].listingStatus`.
   */
  trade2: {
    saleType: "buyout" | "any";
    listingStatus: "securable" | "available" | "online" | "onlineleague" | "any";
    useMapFilters: boolean;
    /** Stored as a ratio, but the window edits it as a percentage — see `settings.ts`. */
    mapMinRatio: number;
  };
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
