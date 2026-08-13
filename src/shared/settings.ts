export interface Settings {
  /**
   * The league prices are looked up against, on poe.ninja, the currency exchange *and* trade2. It
   * can't ship as a working default because leagues rotate every few months, and a stale name isn't
   * an error anywhere — every source simply returns nothing and every item goes unpriced. Confirmed
   * by the user in the setup window instead.
   */
  league: string;
  /**
   * Full path to PoE2's `Client.txt`, tailed for zone transitions to start and end map sessions.
   * Detected from the Steam install on first run (`poe2-install.ts`) and pickable by hand for
   * everything else. Empty is a supported state: map detection is simply off.
   */
  clientTxtPath: string;
  /**
   * Whether the first-run setup window has been answered. False ships in the defaults, so a fresh
   * install — and an existing one upgrading past this key, since `mergeWithDefaults` fills it in —
   * is asked once for the three values above before anything else starts.
   */
  setupCompleted: boolean;
  /**
   * Windows image names of the PoE2 game client, used to detect when to activate the overlay.
   * A list rather than one name because the executable differs between the Steam and standalone
   * clients and has changed across builds (`PathOfExileSteam.exe` vs `PathOfExile_x64Steam.exe`) —
   * a single exact name that goes stale silently disables detection. A legacy `poe2ProcessName`
   * string from an older settings.json is folded into this list on load.
   */
  poe2ProcessNames: string[];
  logWatch: {
    /**
     * How often Client.txt is polled for new bytes. This is the real trigger — `fs.watch` is only
     * an extra nudge, since Windows doesn't reliably signal appends to a file PoE2 holds open.
     */
    pollIntervalMs: number;
    /**
     * Bytes of Client.txt scanned at startup to seed the current zone, so launching the overlay
     * mid-map doesn't sit on "No active map" until the next transition. 0 disables the backfill.
     */
    backfillBytes: number;
    /** Verbose per-poll `[logwatch]` tracing (byte/line counts, skipped placeholder zones). */
    debugLogging: boolean;
  };
  overlay: {
    /**
     * Hide the overlay whenever PoE2 isn't the foreground window (it's `alwaysOnTop` across the
     * whole primary display, so otherwise it covers your browser/Discord when you alt-tab). Costs
     * one long-lived PowerShell helper process while the game runs — see `ForegroundWatcher`. Turn
     * this off if you play windowed on a second monitor and want the overlay permanently visible.
     */
    hideWhenGameUnfocused: boolean;
    /** How often the helper samples the foreground window. Lower = snappier, more CPU. */
    focusPollIntervalMs: number;
    /**
     * Grace period before actually hiding. PoE2 briefly hands the foreground to explorer.exe (or to
     * nothing) during loading screens and fullscreen mode switches; without a delay the overlay
     * flickers on every zone transition.
     */
    hideDelayMs: number;
    /**
     * Size and side of the panel itself, which holds the one item list. Configurable because that
     * list is now the whole app — it holds every drop ever recorded rather than the two-row feed the
     * panel was originally sized for, and the separate, draggable list window it replaced is gone.
     * `maxHeightPercent` is a share of the display height, so a value that fits one monitor doesn't
     * run off the bottom of another.
     *
     * `position` is horizontal only, because the bottom-right corner the panel has always used is
     * also where PoE2 puts the minimap, the buff bar and the flask row — how much they collide
     * depends on UI scale and resolution, so which side is clear is the player's to say. It stays
     * bottom-anchored either way: the panel grows upward into `maxHeightPercent`.
     */
    panel: { width: number; maxHeightPercent: number; position: "left" | "right" };
  };
  hotkeys: {
    /** Click-through vs interactive, without changing the panel's size. */
    toggleOverlay: string;
    /**
     * Opens the full list and makes the overlay clickable, so Edit can be pressed; again closes both.
     * The panel is otherwise always its minimal form — see `OverlayStatus.expanded`.
     */
    toggleList: string;
    toggleSession: string;
    forceCapture: string;
  };
  display: {
    /**
     * Unit prices are shown in. Values are always *stored* in chaos; this only affects rendering.
     * "auto" picks divine for anything worth at least one and exalted below that, which is how
     * players actually quote PoE2 prices — chaos sits between the two and reads badly at both ends.
     */
    currency: "auto" | "exalted" | "chaos" | "divine";
  };
  poeNinja: {
    baseUrl: string;
    /**
     * How often the whole price cache is re-fetched. This is also the cadence of the conversion
     * rates the panel header shows, since poe.ninja returns the rates in the `core` block of every
     * category response — there is no cheaper rates-only endpoint to poll separately.
     *
     * One refresh is one request per configured category (~23 at the defaults), fired in parallel,
     * so shortening this multiplies traffic to a third-party site that publishes no rate limit.
     * 10 minutes is already ahead of how often poe.ninja recomputes; don't go below it.
     *
     * Note this is a primitive, so `mergeWithDefaults()` leaves an existing settings.json alone —
     * changing it here only affects fresh installs.
     */
    refreshIntervalMs: number;
    itemOverviewTypes: string[];
    exchangeOverviewTypes: string[];
  };
  /**
   * GGG's own PoE2 Currency Exchange feed, used only as a fallback behind poe.ninja. Public and
   * unauthenticated, so unlike `trade2` this works without any registration.
   */
  currencyExchange: {
    enabled: boolean;
    /** Realm path segment is appended to this, e.g. `.../currency-exchange` + `/poe2`. */
    baseUrl: string;
    realm: string;
    /**
     * How far back to start reading. The feed publishes hourly digests and has no current-hour
     * data at all, so a seed of 0 or 1 would usually fetch nothing; 2 is the first hour reliably
     * complete.
     */
    lookbackHours: number;
    /** Hours walked forward per refresh from the seed. Caps the work when the stream is behind. */
    maxPagesPerRefresh: number;
    refreshIntervalMs: number;
    /**
     * Units that must have traded in an hour before that market contributes a price. Thin markets
     * are wildly noisy — a market with a hundred-odd units traded can span nearly 5x between its
     * hourly low and high — and a confidently wrong price is worse than no price.
     */
    minVolume: number;
    /**
     * Consult the exchange when poe.ninja's data is older than this, not just when it has no price
     * for the item. Covers poe.ninja being down or failing to refresh. 0 forces the fallback path
     * on every lookup, which is how to exercise it manually.
     */
    stalePoeNinjaAfterMs: number;
    /**
     * Price against a different league than `league`. The feed carries every league in the realm
     * (including private ones), so this is the escape hatch when the played league has too little
     * exchange activity — set it to "Standard" to borrow that economy's prices instead.
     */
    leagueOverride: string;
  };
  /**
   * GGG's PoE2 trade API (`pathofexile.com/api/trade2`), the only automatic price source for Rare
   * items. Public and unauthenticated — there is no client id and no login. What it does need is
   * restraint: GGG rate-limits it per IP at 30 requests per 5 minutes, and a lookup costs two.
   */
  trade2: {
    /** Master switch. Off means Rares stay unpriced until given a manual value via a row's Edit. */
    enabled: boolean;
    /**
     * Sent in the User-Agent so GGG can contact whoever is making the requests — the person running
     * this install, not whoever wrote it. Optional: blank omits the contact clause entirely rather
     * than sending an empty one, and rare pricing works either way. Asked for in the setup window.
     */
    contactEmail: string;
    /**
     * Searches allowed per `windowMs`. Each costs two requests against GGG's 30-per-5-minutes IP
     * budget, which is shared with anything else on this machine hitting the trade API, so the
     * default leaves headroom. Once spent, further Rares are stored unpriced rather than stalling
     * the pricing queue.
     */
    maxSearchesPerWindow: number;
    /** The rolling window `maxSearchesPerWindow` is counted over. Matches GGG's 300s bucket. */
    windowMs: number;
    /**
     * Minimum spacing between searches. GGG's tightest bucket is 5 requests per 10 seconds, so at
     * two requests per lookup anything under ~4s risks a lockout on a burst of rare drops.
     */
    minSearchIntervalMs: number;
    /**
     * How many of the **cheapest** price-sorted listings the median is taken over (see
     * `priceSample`). Capped at 10 by GGG's fetch endpoint, which rejects longer id lists outright.
     *
     * The price this yields is the market floor — what undercutters are currently asking — not what
     * the item is nominally worth. Raising this widens the slice but keeps it anchored to the cheap
     * end; it does not move the sample up the market.
     */
    maxListings: number;
    /**
     * Which sellers count. `"online"` (the default) prices off listings you could buy from right
     * now; `"any"` includes offline sellers, matching the trade site with its status filter cleared.
     *
     * This is the usual reason the app and the site disagree, and the gap is not small: one real
     * four-mod Emerald jewel had **0** online listings carrying all its mods and **5** counting
     * offline ones, and a Sapphire had 0 against 16. `"any"` finds more comparables on thin items,
     * at the cost of pricing against listings that may be months stale and unreachable — an
     * abandoned listing never sold at its asking price.
     */
    listingStatus: "online" | "any";
    /**
     * How many mod thresholds one lookup may try before settling, strictest first: 3 searches an
     * item's full mod set, then one fewer, then `minModMatchRatio`'s floor. Each rung that misses
     * costs another request against GGG's per-IP limit, so this is the knob that trades pricing
     * precision for how many rares a busy map can price at all. 1 disables the ladder and searches
     * only the floor, which is what this did before. See `modLadder()`.
     */
    maxModLadderSearches: number;
    /**
     * Listings a mod threshold must match before its price is taken at face value; below it the
     * ladder keeps loosening. Deliberately larger than `maxListings`: the sample only needs to be
     * fillable, but the *rung* has to describe a market before it's worth sampling at all — under
     * that the "median" is a handful of asking prices whichever end you take it from.
     *
     * Measured on a real Ruby jewel: matching all 4 mods found 1 listing, 3 of 4 found 9 (median
     * 1 divine), and 2 of 4 found 236 (median ~30 exalted, which is what sellers of that jewel were
     * actually asking). Both thin rungs report a stranger's hopes; only the deep one reports a
     * market. Lower this to prefer specificity over sample depth, 1 to always take the strictest
     * rung that matched anything.
     */
    minListingsForMatch: number;
    /**
     * Fraction of an item's matched mods a listing must also have to count as comparable. Requiring
     * all of them finds nothing for a typical four-to-six-mod rare — see `requiredModMatches()` for
     * the measurements. Raise it toward 1 for stricter comparisons and more unpriced rares; lower it
     * for looser matches and prices biased further below what the item is actually worth.
     */
    minModMatchRatio: number;
    /**
     * Search rare armour by the defence totals the game prints (`Armour: 1081`) instead of by the
     * individual mods that produced them, using GGG's `equipment_filters`.
     *
     * This is the difference between finding a market and not. GGG indexes the *total*, so asking
     * for the exact rolls of `+N to Armour` and `N% increased Armour` asks for an item nobody else
     * has: a real Soldier Cuirass returned 0 listings on all 4 of its mod filters, 0 on 3, and only
     * 4 on 2 — while the same base at a comparable armour total has a deep market. The contributing
     * mods stop being stat filters when this is on, which is what shortens the ladder too.
     *
     * `false` restores the old payload exactly. Only mods on an item that *displays* the defence
     * are folded, so a global `+N to maximum Energy Shield` on a ring is unaffected either way.
     */
    useDefenceFilters: boolean;
    /**
     * The defence floor to search on, as a fraction of the item's own total: 0.9 turns 1081 armour
     * into `"ar": { "min": 973 }`. There is no maximum — the middle-window median already handles a
     * wide spread, and a ceiling mostly just turns priced items into unpriced ones.
     *
     * Below 1 on purpose. At parity the only matches are items strictly *better* than this one, so
     * the median prices something the item isn't. It also absorbs a skew that can't be corrected
     * exactly: GGG indexes these values "including maximum quality" while the clipboard prints them
     * at the item's current quality, and separating the base value from `increased%` to normalise
     * that needs a base-item table this app doesn't have. At 20% quality — the normal case for
     * anything worth pricing — the printed number is already exact.
     */
    defenceMinRatio: number;
    /**
     * Search resistances, life, mana, attributes and global energy shield as GGG's *pseudo*
     * aggregates — one "83% total Elemental Resistance" filter in place of the three resistance rolls
     * that add up to it.
     *
     * Same argument as `useDefenceFilters`, for the stats that have no property line: GGG indexes the
     * total and the market prices the total, so three filters pinned to +38 cold, +25 fire and +20
     * lightning ask for a listing nobody has. The contributing mods stop being individual stat
     * filters when this is on, which shortens the ladder as well.
     *
     * An aggregate is only derived when at least **two** mods feed it — folding a single resistance
     * roll would match an item whose total is all one other element. `false` restores the old payload
     * exactly. Note GGG publishes no pseudo for armour, evasion or ward; those stay on
     * `equipment_filters` either way.
     */
    usePseudoFilters: boolean;
    /**
     * The aggregate floor to search on, as a fraction of the item's own total: 0.9 turns 83% total
     * elemental resistance into `{ "min": 74 }`. Below 1 for the same reason as `defenceMinRatio` —
     * at parity the only matches are items strictly better than this one, and a median over those
     * prices something the item isn't. No maximum, for the same reason either.
     */
    pseudoMinRatio: number;
    /**
     * Search a waystone on the reward totals it prints — Item Rarity, Pack Size, Monster Rarity and
     * Waystone Drop Chance — through GGG's `map_filters`, instead of on its affixes.
     *
     * The strongest case of the three folds. A waystone's affixes are monster-difficulty mods, and
     * the reward block is what the whole affix set produces *collectively*, so there is no per-mod
     * mapping the way there is for armour: the affixes are simply the part nobody else has in the
     * same combination. Measured on a real T15 capture — its six affixes matched 0 listings, three of
     * them matched 118, and its reward totals matched 3453.
     *
     * All affix stat filters are dropped when this is on. `false` restores the old payload exactly.
     *
     * Monster Effectiveness and Revives are parsed but never filtered: they describe difficulty,
     * which is a cost to the buyer, so a floor on them would exclude the easier maps worth *more*.
     * Waystone Tier isn't filtered either — the base type is per-tier ("Waystone (Tier 15)"), which
     * already pins it. Measured: that type plus `map_tier: { min: 16 }` returns zero listings.
     */
    useMapFilters: boolean;
    /**
     * The reward floor to search on, as a fraction of the waystone's own total: 0.9 turns
     * `Item Rarity: +24%` into `"map_iir": { "min": 21 }`. Below 1 for the same reason as
     * `defenceMinRatio` — at parity the only matches are waystones strictly better than this one.
     */
    mapMinRatio: number;
    /**
     * Extra attempts after a **transient** failure — GGG 5xx or a dead socket. Without this, one
     * blip (a real capture caught `HTTP 502` from trade2 and the currency exchange in the same
     * second) stores the item unpriced permanently, which is indistinguishable from "this rare has
     * no market". Each retry spends another search from the budget above. 4xx and 429 are never
     * retried: the query was rejected, or the budget is already set too high for this IP.
     */
    maxTransientRetries: number;
  };
}
