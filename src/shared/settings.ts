export interface Settings {
  /**
   * The league prices are looked up against, on poe.ninja, the currency exchange *and* trade2. It
   * can't ship as a working default because leagues rotate every few months, and a stale name isn't
   * an error anywhere — every source simply returns nothing and every item goes unpriced. Confirmed
   * by the user in the setup window instead.
   */
  league: string;
  /**
   * Whether the first-run setup window has been answered. False ships in the defaults, so a fresh
   * install — and an existing one upgrading past this key, since `mergeWithDefaults` fills it in —
   * is asked once for the values it covers before anything else starts.
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
  /**
   * The release check — see `main/update-check.ts`.
   *
   * **This app notifies, it does not update itself**, and the block is small because of it: there is
   * nothing here about download paths or install behaviour, because it downloads and installs
   * nothing. Three things ruled auto-update out. One of the two shipped targets is a *portable* exe,
   * which has no install to replace; neither binary is code-signed, so a silent background install
   * puts a SmartScreen prompt somewhere the user cannot see or answer it; and the release workflow
   * uploads only the exes, not the `latest.yml` an updater would read.
   *
   * Deliberately **not** in `SettingsConfig`, so it has no field in the settings window. The bar
   * there is "must this be editable for the app to work", not "is this configurable" — both keys
   * ship with a working default, and the off switch is for someone who has opened settings.json
   * anyway.
   */
  updates: {
    /**
     * Whether to ask GitHub about newer releases at all. False skips the check outright — no timer,
     * no request — for a user who would rather the app not talk to github.com.
     */
    checkForUpdates: boolean;
    /**
     * How often to re-check after the one at startup. Six hours by default, against an
     * unauthenticated GitHub limit of 60 requests per hour per IP: the interval is long because a
     * release is not urgent, not because the budget is tight.
     */
    checkIntervalMs: number;
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
    /**
     * How many category requests a refresh may have in flight at once.
     *
     * poe.ninja publishes no rate limits and returns no `X-Rate-Limit-*` headers, so unlike the GGG
     * hosts there is nothing to measure and nothing to react to — which argues for restraint rather
     * than against it. A refresh is one request per category (23 by default), and firing all of them
     * simultaneously at a free community service behind Cloudflare is the pattern that gets an IP
     * blocked. Nothing waits on a refresh, so the pool costs only wall clock on a 10-minute timer.
     */
    maxConcurrentRequests: number;
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
     * Searches allowed per `windowMs`. Once spent, further Rares are stored unpriced rather than
     * stalling the pricing queue.
     *
     * Sized against GGG's `30:300:1800` bucket — 30 requests per 5 minutes, then a **30-minute**
     * lockout — confirmed live from `X-Rate-Limit-Ip` rather than taken from the policy page. The
     * conversion is the part worth getting right: the budget counts *searches* while GGG counts
     * *requests*, and a lookup is N ladder rungs (all budgeted) plus **one** unbudgeted fetch of the
     * winning rung. The worst ratio is therefore a lookup that hits on its first rung — 2 requests
     * for 1 search — and it improves from there, so 2:1 is the safe number to size by.
     *
     * At the default of 8: 16 of GGG's 30 requests, leaving about half the bucket spare. That spare
     * is not slack to reclaim — the limit is per **IP**, not per app, so a second copy of this
     * overlay or any other trade tool on the same connection spends the same bucket, and the
     * one-off `/data/stats` fetch comes out of it too. It shipped at 12 — 24 of the 30, four fifths
     * of the bucket — until that headroom was judged too thin to absorb another tool on the same
     * connection. 15 would sit exactly on the ceiling and make an unrelated tool's single request
     * the thing that triggers a 30-minute blackout.
     */
    maxSearchesPerWindow: number;
    /** The rolling window `maxSearchesPerWindow` is counted over. Matches GGG's 300s bucket. */
    windowMs: number;
    /**
     * A second, much longer budget, counted the same way and enforced alongside the short one.
     *
     * GGG's `600:21600:3600` bucket is 600 requests per **6 hours**, and exceeding it is an
     * hour-long lockout — by far the worst penalty on the list. The short window alone permits 8
     * searches per 5 minutes, which is ~192 requests an hour sustained, so a long mapping session
     * spending the budget continuously would breach the 6-hour ceiling after roughly three hours.
     * Tuning the *short* window down to prevent that would have throttled the ordinary case — a
     * burst of drops in one map — to guard against something only hours of play reach.
     *
     * The default is 160 searches, i.e. at most ~320 of GGG's 600 requests — a little over half the
     * bucket, leaving room for the one-off `/data/stats` fetch and for anything else on the machine
     * using the trade API.
     */
    maxSearchesPerLongWindow: number;
    /** The rolling window `maxSearchesPerLongWindow` is counted over. Matches GGG's 21600s bucket. */
    longWindowMs: number;
    /**
     * Minimum spacing between searches, and the only thing keeping a burst inside GGG's *short*
     * buckets — the budget above counts searches, while the limits count requests.
     *
     * A lookup is one budgeted search plus an **unbudgeted** fetch of the winning rung, so a full
     * burst of 8 searches is up to 16 requests. Against `15:60:300` — 15 requests a minute, 5
     * minutes of lockout — 5s spacing packs those 16 into 40 seconds and breaches it. The default of
     * 15s caps any 60-second stretch at 4 searches and ~8 requests, a little over half that limit,
     * and costs nothing: `maxSearchesPerWindow` over `windowMs` is the real ceiling either way, and
     * a lone rare drop waits not at all because there is no previous search to be spaced from.
     */
    minSearchIntervalMs: number;
    /**
     * A migration marker, not a preference — the same mechanism as `listingStatusMigrated` below,
     * for the three budget keys above.
     *
     * `mergeWithDefaults` only fills in keys that are *missing*, so lowering the shipped budget from
     * 12/240/10s to 8/160/15s reached new installs and nobody else: an existing settings.json would
     * have gone on spending four fifths of GGG's per-IP buckets indefinitely, with nothing on screen
     * to say so. `adoptSearchBudgetDefaults` (`main/settings.ts`) rewrites exactly those three old
     * shipped values once and stamps this, so a budget tuned by hand is never overridden. Defaults
     * to `false` precisely so old installs migrate; a fresh one already holds the new values and
     * the fold only stamps the marker.
     */
    searchBudgetMigrated: boolean;
    /**
     * How many of the **cheapest** price-sorted listings the price is taken from (see
     * `priceSample`). Capped at 10 by GGG's fetch endpoint, which rejects longer id lists outright.
     *
     * The price this yields is the market floor — what undercutters are currently asking — not what
     * the item is nominally worth. Raising this widens the slice but keeps it anchored to the cheap
     * end; it does not move the sample up the market.
     */
    maxListings: number;
    /**
     * Which listings count — GGG's `status` filter, whose options are **not** simply an online/offline
     * toggle. Confirmed against `/api/trade2/data/filters`, the five it accepts are:
     *
     * | value | GGG's label | what it means |
     * |---|---|---|
     * | `"securable"` | Instant Buyout | buyable on the spot, no whisper, seller needn't be online |
     * | `"available"` | Instant Buyout and In Person | both routes |
     * | `"online"` | In Person (Online) | seller is online; you whisper and meet to trade |
     * | `"onlineleague"` | In Person (Online in League) | as above, restricted to this league's characters |
     * | `"any"` | Any | everything, including sellers who logged off weeks ago |
     *
     * **The default is `"securable"`**, because it is the only option that matches what this app's
     * prices claim to mean. `priceSample` deliberately reports the market *floor* — what you can sell
     * into today — and an in-person listing is not something you can transact against on demand: it
     * needs the seller to answer a whisper and invite you. An instant buyout is a real, executable
     * price. Measured live on a `Sapphire Ring` base: `online` returned 5678 listings and `securable`
     * returned 10000+, so this is not the narrower market it sounds like.
     *
     * This is the usual reason the app's number disagrees with the trade site, and the gap is not
     * small in either direction: one real four-mod Emerald jewel had **0** *In Person (Online)*
     * listings carrying all its mods and **5** counting offline ones, and a Sapphire had 0 against
     * 16. Widening toward `"any"` finds more comparables on thin items, at the cost of pricing
     * against listings that may be months stale and unreachable — an abandoned listing never sold at
     * its asking price.
     */
    listingStatus: "securable" | "available" | "online" | "onlineleague" | "any";
    /**
     * A migration marker, not a preference — there is no reason for anyone to set it by hand.
     *
     * The shipped default for `listingStatus` was once `"online"`, and `mergeWithDefaults` only fills
     * in keys that are *missing*, so changing that default reached new installs and nobody else: an
     * existing settings.json kept searching in-person listings indefinitely, with nothing on screen
     * to say so. `adoptInstantBuyoutDefault` (`main/settings.ts`) takes such an install to
     * `"securable"` exactly once and stamps this, so a user who later picks `"online"` in the
     * settings window keeps it. Defaults to `false` precisely so old installs migrate; a fresh one
     * is already on `"securable"` and the fold only stamps the marker.
     */
    listingStatusMigrated: boolean;
    /**
     * Whether `adoptListingThresholdDefault` has run. Same mechanism as the marker above, for the
     * other default that changed under existing installs.
     *
     * `minListingsForMatch` shipped as **10** and became **1**, so an install predating that kept a
     * ladder that walked past the rung carrying the item's whole mod set whenever fewer than ten
     * listings had it — pricing a four-mod rare off three, and looking exactly like a search that
     * had failed to find listings the trade site plainly showed. Defaults to `false` so those
     * installs migrate; on a fresh one the fold finds the current value and only stamps the marker.
     */
    minListingsThresholdMigrated: boolean;
    /**
     * Whether a listing has to be buyable on the spot to count. `"buyout"` (the default) prices off
     * listings with a buyout or fixed price; `"any"` also counts listings with no listed price,
     * where buying means whispering the seller and haggling.
     *
     * `"buyout"` sends **no** `sale_type` filter at all, which is measured rather than assumed: on a
     * real `Alpha Talisman` search, omitting it returned 239 listings, `sale_type: unpriced`
     * returned 93, and `sale_type: any` returned 332 — exactly 239 + 93. GGG's own filter reference
     * agrees, listing "Buyout or Fixed Price" as the option with a `null` id, i.e. the state the
     * dropdown is in when nothing is sent. **Don't try to send that `null` explicitly**: the API
     * rejects `{ option: null }` with `400 Invalid sale type`.
     *
     * Unpriced listings are worth excluding by default because this app prices off the
     * *cheapest* listings, and an unpriced one carries no number to sort by — it can only dilute the
     * sample or occupy a slot that a real asking price would have filled.
     */
    saleType: "buyout" | "any";
    /**
     * Relax a search that found nothing by **dropping** an item's most expendable mod and still
     * demanding all the rest, one mod per rung.
     *
     * This is the only relaxation there is. The alternative — keeping every filter and lowering the
     * "at least N of M" threshold — was removed on purpose: it lets a listing miss *any* one mod,
     * which on a good item is usually the T1 roll that is the reason it is worth anything, and since
     * different listings satisfy different subsets there is no set of mods to report back. Dropping a
     * named filter asks for a specific, slightly worse item, which is how a player narrows a search by
     * hand and which leaves a knowable set behind — what `PricedItem.autoDroppedMods` and
     * `searchedMods` record, and what lets the row editor tick the mods that produced the price.
     *
     * **Off means no relaxation at all**: one rung, every mod required, and an item with no market at
     * those exact rolls stays unpriced. Advanced Item Descriptions is no longer required — without it
     * no mod has a tier, so the drop *order* falls back to the item's own order, but dropping still
     * happens. See `droppableFilters()` and `searchRungs()`.
     */
    useModDropLadder: boolean;
    /**
     * How many mods one lookup may shed, at one search each, before giving up and storing the item
     * unpriced.
     *
     * GGG rate-limits trade2 **per IP** and a priced lookup costs two requests, so the ceiling that
     * matters is `maxSearchesPerWindow` over `windowMs`; a rare that walks every rung here can spend
     * most of a window by itself and leave the rest of a busy map's drops unpriced. Raise it to price
     * more stubborn rares, lower it to keep the budget spread across more items. 0 disables dropping
     * as surely as `useModDropLadder: false` does.
     *
     * `minModMatchRatio` is the other bound on how far this goes, and usually the binding one.
     */
    maxModDropSearches: number;
    /**
     * The affix tier at which a mod counts as **weak**, worst-or-equal. At the default of 3, tiers 3
     * and up are shed first — 1 is the best possible roll in PoE.
     *
     * This orders the drops rather than gating them, which is what changed when the count axis was
     * removed. Everything is droppable eventually, in three bands: known-weak first (worst tier
     * first), then mods whose tier the game did not print, then known-good (T2 before T1). Raise it to
     * shed more of the item before touching a good roll; lower it toward 1 to protect less.
     *
     * Nothing here forbids a drop any more, so an item captured without Advanced Item Descriptions
     * still relaxes — it just does so in item order, having no tiers to sort by. `minModMatchRatio`
     * is what stops the shedding, not this. See `droppableFilters()`.
     */
    modDropTierThreshold: number;
    /**
     * Listings a rung must match before its price is taken at face value; below it the ladder keeps
     * loosening. **The default of 1 means "stop at the first rung that matched anything at all"**,
     * which is the most specific comparison available for the item.
     *
     * This trades sample depth for specificity, deliberately, and the tradeoff is worth understanding
     * because it runs the other way from what the number suggests. Measured on a real Ruby jewel:
     * all 4 mods found 1 listing, 3 of 4 found 9 (median 1 divine), and 2 of 4 found 236 (median ~30
     * exalted, which is what sellers of that jewel were actually asking). At 1 this reports the
     * 1-listing rung — one stranger's asking price, taken from an item that really is this item. At
     * 10 it descends to the 236-listing rung, which describes a market but describes it for a looser
     * item than the one in your stash.
     *
     * Neither is wrong; they answer different questions. Raise this toward 10 to prefer a real market
     * over an exact match.
     *
     * **The row no longer signals a thin rung.** This used to be safe at 1 partly because the price
     * carried a median in parentheses, and the two figures being close was the reader's evidence that
     * a one-listing rung meant anything. That parenthetical was replaced by the listing's age, so a
     * price off one listing now looks exactly like a price off twenty. The sample size survives only
     * in the `[pricing] … cheapest of N sampled` log line. Worth revisiting this default, or putting
     * the count back on the row, before treating 1 as obviously correct.
     */
    minListingsForMatch: number;
    /**
     * Fraction of an item's mods that must **stay in the query** — the floor the drop ladder may not
     * shed past. At the default of 0.5 a five-mod rare never searches on fewer than three of its mods.
     *
     * It used to mean "fraction a listing must share", for the `count` group that no longer exists.
     * Same arithmetic, stricter promise: every surviving mod is now *required* of every listing, where
     * before any N of them sufficed. Raise it toward 1 for prices that describe this exact item and
     * more unpriced rares; lower it to price more items off less of what makes them good.
     * See `minSurvivingFilters()`.
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
     * into `"ar": { "min": 973 }`. There is no maximum — the cheap-window sample already handles a
     * wide spread, and a ceiling mostly just turns priced items into unpriced ones.
     *
     * Below 1 on purpose. At parity the only matches are items strictly *better* than this one, so
     * the price describes something the item isn't. It also absorbs a skew that can't be corrected
     * exactly: GGG indexes these values "including maximum quality" while the clipboard prints them
     * at the item's current quality, and separating the base value from `increased%` to normalise
     * that needs a base-item table this app doesn't have. At 20% quality — the normal case for
     * anything worth pricing — the printed number is already exact.
     */
    defenceMinRatio: number;
    /**
     * Search a weapon on the elemental DPS it prints (`equipment_filters.edps`) and drop the
     * `Adds # to # Fire Damage` rolls that produced it from the stat filters.
     *
     * Exactly the argument behind `useDefenceFilters`, one item class over: the game has already
     * folded those rolls into the printed damage, GGG indexes the product of that and the attack
     * rate, and asking for the rolls individually asks for a weapon nobody else has.
     *
     * Its own switch rather than a share of `useDefenceFilters` because they are two features that
     * happen to travel in one filter group — an install can want armour totals and not weapon DPS.
     * The floor under it is `defenceMinRatio`, which is deliberately shared: eDPS is a continuous
     * stat like armour, so a second ratio would only ever hold the same number.
     *
     * **There is no elemental *damage* pseudo to use instead.** Confirmed against the live
     * `/api/trade2/data/stats`: PoE2's pseudo group is 36 entries of resistances, attributes,
     * life/mana/energy shield, movement speed and mod counts. `edps` is the only aggregate route
     * there is, which is why this sits here rather than in `shared/pseudo-stats.ts`.
     */
    useWeaponFilters: boolean;
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
     * at parity the only matches are items strictly better than this one, and a price off those
     * describes something the item isn't. No maximum, for the same reason either.
     */
    pseudoMinRatio: number;
    /**
     * Search a waystone on the totals it prints — Item Rarity, Pack Size, Monster Rarity, Waystone
     * Drop Chance, Revives and Monster Effectiveness — through GGG's `map_filters`, instead of on
     * its affixes.
     *
     * The strongest case of the three folds. A waystone's affixes are monster-difficulty mods, and
     * the printed block is what the whole affix set produces *collectively*, so there is no per-mod
     * mapping the way there is for armour: the affixes are simply the part nobody else has in the
     * same combination. Measured on a real T15 capture — its six affixes matched 0 listings, three of
     * them matched 118, and its reward totals matched 3453.
     *
     * All affix stat filters are dropped when this is on. `false` restores the old payload exactly.
     *
     * **Monster Effectiveness is sent as a ceiling, not a floor.** It used to be excluded outright,
     * on the grounds that difficulty is a cost to the buyer and a floor would exclude the easier maps
     * worth *more* — right about the direction, wrong about the remedy. A ceiling asks for the maps
     * at most this dangerous, which is what the comparables actually are; sending nothing priced a
     * 5% waystone against 50% ones. Revives keeps a floor: more attempts is a benefit.
     *
     * Waystone Tier still isn't filtered — the base type is per-tier ("Waystone (Tier 15)"), which
     * already pins it. Measured: that type plus `map_tier: { min: 16 }` returns zero listings.
     */
    useMapFilters: boolean;
    /**
     * How far to widen a waystone's printed totals when searching, as a fraction of each: 0.9 turns
     * `Item Rarity: +24%` into `"map_iir": { "min": 21 }` and `Monster Effectiveness: +13%` into
     * `"map_magic_monsters": { "max": 15 }`. Below 1 for the same reason as `defenceMinRatio` — at
     * parity the only matches are waystones strictly better than this one.
     *
     * One ratio for both directions, like `defenceMinRatio` also serving eDPS: a second knob would
     * only ever hold the same number. The settings window edits it as a percentage.
     */
    mapMinRatio: number;
    /**
     * Whether a **Normal**-rarity base item is worth a trade search at all.
     *
     * Off-by-default would be the safe reading, but the gate that actually matters is
     * `baseItemMinLevel` below: white bases drop constantly and almost all of them are worth
     * nothing, so the cost of switching this on is bounded by the floor rather than by the flag.
     * Magic items are still excluded and always will be — PoE2 glues the affixes onto the base on
     * one header line, so there is no base type left to search with.
     */
    useBaseItemSearch: boolean;
    /**
     * The item level a Normal-rarity base has to reach before it costs a search. Below it the item is
     * stored unpriced without a request being made, which is the entire point: the rate limit is per
     * **IP** and shared with every rare dropping in the same map.
     *
     * The floor sent to GGG is the item's **own** level, exactly, with no ratio — unlike
     * `defenceMinRatio` and its neighbours. Item level is a discrete breakpoint rather than a
     * continuous stat, and 0.9 of 82 is 73, which is a different market entirely rather than a
     * slightly wider one.
     */
    baseItemMinLevel: number;
    /**
     * The cheapest listing worth counting. 0 switches the floor off.
     *
     * PoE2's cheap end is a wall of dump listings, and `priceSample` deliberately reads that end —
     * so without a floor a rare's reported value is routinely some fraction of a chaos. A real
     * capture priced at **0.09 chaos** where the same ten listings ran to 0.6, which is
     * not a price so much as evidence that nobody is really selling one.
     *
     * Sent to GGG as `trade_filters.filters.price`, so it constrains the **search** rather than the
     * sample. That is not an implementation detail: `priceSample` takes the ten *cheapest* matches,
     * so a floor applied after the fetch would usually find every one of them below it and leave
     * nothing to price. Filtering server-side means the ten cheapest are the ten cheapest that clear
     * the floor, and every listing count in the log is counting the same set the price came from.
     *
     * An item with nothing at or above the floor is stored **unpriced**, with a reason saying so.
     * There is no retry without it, unlike the defence and aggregate floors: those exist to widen a
     * search that was too specific, while this one exists to reject a market that isn't worth
     * recording, and retrying without it would hand back exactly the number it was set to suppress.
     *
     * **It names no currency, and must not.** The `option` field on GGG's price filter selects the
     * currency a listing is *quoted in* rather than a unit to compare against, so the
     * `{ min: 1, option: "exalted" }` this used to send meant "listings priced in exalted orbs" and
     * silently threw away every divine-priced one — the whole expensive end of every market. A bare
     * `min` compares across currencies, in a unit of GGG's own that measures one divine somewhere
     * between 400 and 3000 (poe.ninja's rate would call it 347 exalted). Near enough to exalted that
     * 1 still means about what it reads as; don't write "exalted" into the docs or the log, and don't
     * add the currency back to tidy the wording.
     */
    minListingPrice: number;
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
