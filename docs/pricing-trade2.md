# GGG API compliance and trade2 search

`src/pricing/ggg-fetch.ts`, `rate-limiter.ts`, `trade-budget.ts`, `trade2-client.ts`,
`trade-stats.ts`, and the `shared/` stat derivations they use.

**This is the file to read before changing how an item is searched for.** Nearly every rule below is
a measured result, and several look like bugs until you read why they aren't — the removed count
axis, the price floor's missing `option`, the strict-rung rule, the pseudo aggregates. Each of those
has caused a repeat regression.

Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---

**GGG API compliance** (`src/pricing/ggg-fetch.ts`, `rate-limiter.ts`, `trade-budget.ts`,
`trade2-client.ts`, `trade-stats.ts`) exists because this app is subject to GGG's third-party
developer API policy — see the README's compliance section for the policy reasoning per feature.

**Every GGG endpoint this app calls is public and unauthenticated.** There is no OAuth anywhere, by
design and not by limitation. This is stated so plainly because the codebase previously got it
wrong: `Trade2Client` implemented OAuth 2.0 + PKCE against `service:psapi` and was permanently
inert, on the belief that trade search needed a `client_id` GGG would not issue. Two distinct APIs
were being conflated — GGG's *documented OAuth API* (profile/stashes/characters) does require
registration, registration is closed, and it documents no trade search endpoint or scope; but
`www.pathofexile.com/api/trade2/*` is a different, openly-served surface that answers anonymous
requests. **Don't reintroduce an auth gate, a `clientId` setting, or `Authorization` headers on
trade2 calls** — a Bearer token on an endpoint that takes none fails silently, which is exactly how
this stayed broken.

Practically:
- `createPublicGggFetch()` is the only way GGG endpoints should be called. It attaches an
  app-identifying `User-Agent: {app}/{version} (contact: {contact})` — *not* the policy's
  `OAuth {clientId}/...` form, which is for registered clients — and self-throttles against
  `X-Rate-Limit-*` response headers (parsed in `rate-limiter.ts`), backing off on 429s.
- `GggRateLimiter` is **reactive** (it learns the ceiling from a response) and throttles by
  **sleeping**. Both are wrong for trade search on their own, so `TradeSearchBudget`
  (`trade-budget.ts`) sits in front: it is proactive, and once its window budget is spent it
  **declines** the lookup instead of waiting. Sleeping there would block the serial `PricingQueue`
  for minutes and stall every poe.ninja-priceable drop queued behind a pile of rares. Declined
  items are stored unpriced with a reason; the row's Reprice button retries them at human pace.
- **Why a lookup failed is marked on the item, not just logged** — `TradeEstimate.failure`
  (`TradeFailure` in `shared/types.ts`), persisted as `PricedItem.unpricedReason` by both write paths,
  and shown on the row as its own badge word in place of **unpriced** (`UNPRICED_REASON` and
  `sourceBadge` in `common.ts`, the value text in `renderItemRow`). One word used to cover seven
  situations that ask opposite things of the reader: "unpriced" reads as a finding about the item —
  the market has nothing matching it, and waiting changes nothing — while a declined lookup means no
  search ever went out and the answer arrives on its own. Six things:
  - **It is a typed kind on the estimate, not a pattern match on `reason`.** That string is
    user-facing prose that gets reworded; four separate call sites produce a rate-limited outcome
    (budget spent up front, budget spent mid-ladder before the looser rungs, a transient failure with
    no slot left to retry, and GGG answering 429) and they share no wording. The same goes for the
    other kinds — `searchFailed` is produced by an HTTP error, a thrown fetch and exhausted retries.
  - **It is deliberately not a fifth `priceSource`.** That field says where a price *came from*, and
    none of these is a source. `explainUnpriced` separates the situations that never reach trade2 at
    all, so a reason field scales where a source member wouldn't.
  - **`explainUnpriced` returns the kind and the sentence together**, and is the only place either is
    decided. The sentence is the log line and the badge's tooltip, verbatim, stored as
    `unpricedDetail`. Two functions would let the badge and the tooltip under it disagree, which is
    worse than the one word they replaced.
  - **`REPRICE_ITEM` writes both outside its priced-only conditional**, so they are cleared as well as
    set. An item that failed an hour ago and has since priced would otherwise keep the badge for good,
    and one that failed for a new reason would keep the old sentence.
  - **Only the kinds that resolve on their own get the cool hue** — `rateLimited`, `pricesLoading` and
    `searchFailed` wear `badge-ratelimited`, the rest `badge-unpriced`. That is the one distinction
    among them worth carrying in colour: blue means the answer is still coming, tan means the market
    has already given it. `source-badge.test.ts` pins the split.
  - **Absent is the fallback, and it reads as "nothing more to say".** Nothing migrates
    `loot-cache.json`, which is the honest direction here — a reason old enough to predate the field
    has long since stopped describing anything. An unrecognised code falls back the same way, so a
    downgrade shows the old word rather than a raw identifier.
- **The rate-limit cooldown counts down live, in two places.** `Trade2Client.cooldownMs()` delegates
  to the budget (which stays private), `buildStatus()` turns it into an **absolute deadline** on
  `OverlayStatus.tradeCooldownUntil`, and the panel counts down against its own clock — the header's
  `#cooldown-status` line and every rate-limited row's value cell, which reads `retry in 4:32` and
  then `ready to reprice`. Five things:
  - **The status carries a deadline, never a remaining duration.** A duration freezes between pushes,
    which is the exact bug this fixes. Both processes share one machine clock, so there is no skew.
  - **The per-second tick never crosses IPC.** `applyStatus` ends in `scheduleRender()`, a wholesale
    list rebuild — the same reason `PRICING_STATUS` has its own channel. `OVERLAY_STATUS` is pushed
    only when the deadline *moves*, which is when a lookup finishes and spends a slot.
  - **`tickCooldown` rewrites labels, it does not re-render.** `renderList()` restores `scrollTop` and
    the open editor by hand; running that every second would fight the user's scrolling and their
    half-ticked mod boxes. Same approach as `refreshElapsedLabels`.
  - **The ticker stops when the cooldown does** (`syncCooldownTimer`), like the pending-capture timer.
    An overlay sitting on a game should not hold a 1s wakeup forever.
  - **The countdown is global and stored nowhere.** GGG limits by IP, so one window covers every item;
    a row rate-limited an hour ago shows the *current* cooldown, which is genuinely what pressing its
    Reprice button would run into. Nothing per-item is persisted, and nothing auto-retries at zero.
  - **Do not confuse it with `unpricedDetail`.** The "retry in ~Ns" inside that string is frozen at
    the moment the refusal was worded and is never updated — it is a record of the decline, while the
    countdown is the live answer. The formatter has three tiers because `cooldownMs()` reports the
    longest wait across *both* windows and the long one is six hours; `mm:ss` would say `360:00`.
- GGG rate-limits trade2 **by IP, not by app** (`5:10:60,15:60:300,30:300:1800,600:21600:3600` —
  and a lookup costs two requests, search then fetch), so a second copy of the app, or a trade tool
  running alongside it, spends the same budget. `TradeStatsMatcher` also draws on it, though only
  once per run. (`CurrencyExchangeClient` does not — that feed is on `web.poecdn.com` under a
  different policy.) Defaults leave deliberate headroom; don't raise them to "use the full limit".
  Confirmed still live: a search response advertises exactly that rule under
  `x-rate-limit-policy: trade-search-request-limit`, while `/api/trade2/data/*` sends **no**
  rate-limit headers at all — so `GggRateLimiter` genuinely has nothing to learn from those.
- **`TradeSearchBudget` tracks two windows, because the budget counts searches while GGG counts
  requests.** A lookup is N ladder rungs — **all** budgeted, one slot each — plus **one** unbudgeted
  fetch of the winning rung. So the worst request-per-search ratio is 2:1, on a lookup that hits at
  the top rung, and it improves as the ladder descends. Size against 2:1; the short window's 12
  searches are therefore at most 24 requests. Three consequences, all settled by configuration rather
  than by code:
  - Against `30:300:1800` — 30 requests per 5 minutes, **30 minutes** of lockout — `maxSearchesPerWindow`
    is the ceiling, at **12** for 24 of the 30. Don't take it to 15 "to use the full limit": the rule
    is per **IP**, so a second copy of the app, another trade tool, or the one-off `/data/stats`
    fetch spends the same bucket, and at 15 someone else's single request triggers the blackout.
  - Against `15:60:300` — 15 requests a minute, 5 minutes of lockout — `minSearchIntervalMs` is the
    only thing shaping the burst, and it is what bounds this window regardless of the 5-minute cap.
    At 5s, searches and their fetches pack ~20 requests into 45 seconds and breach it; the default is
    **10s**, which caps any 60-second stretch at 6 searches and ~12 requests. It costs nothing, since
    `maxSearchesPerWindow` over `windowMs` is the real ceiling either way, and a lone drop still waits
    not at all, having no previous search to be spaced from.
  - Against `600:21600:3600` — 600 requests per 6 hours, and an **hour-long** lockout, the worst
    penalty on the list — the short window is blind: it refills twelve times an hour. Hence
    `maxSearchesPerLongWindow`/`longWindowMs` (240 per 6h, so ≤480 of the 600). **This one is not
    raised alongside the short window** — 12 searches per 5 minutes sustained is 864 per 6 hours, so
    the long window is what binds during a heavy session, and that is exactly its job. Tuning the short
    window down far enough to cover this instead would throttle the ordinary case — a burst of drops
    in one map — to guard against something only hours of continuous mapping reach. `cooldownMs()`
    reports the **longest** wait across full windows, or the "retry in ~Ns" message would send the
    user to press Reprice while the search still can't go out.
- The fetch endpoint rejects **more than 10 ids** with `400 {"error":{"code":2}}`, hence
  `MAX_FETCH_IDS`. Search takes the realm as a path segment (`/search/poe2/{league}`); fetch takes
  it as a query param (`?query={searchId}&realm=poe2`).
- `TradeStatsMatcher` fetches/caches GGG's public `/api/trade2/data/stats` reference and turns
  `#`-placeholder stat templates into regexes to match parsed mod text against stat IDs, used to
  build real mod-aware trade2 search filters instead of base-type-only search. **Each mod is looked
  up in its own `ModKind` group first**, then `explicit`, then `implicit`. That routing is
  load-bearing, not tidiness: by display text alone `crafted`, `fractured` and `desecrated` are
  100% subsets of `explicit` and `enchant` is 99%, so one pooled list would hand back an explicit
  stat id for a crafted mod almost every time — a filter for a different item. `pseudo` is still
  **not** loaded into the matcher and must stay out of `searchOrder()` — its templates never appear
  verbatim on an item, and its text overlaps explicit text closely enough to out-match real mods.
  Pseudo aggregates are *derived* instead, in `shared/pseudo-stats.ts` — see below.
- A stat GGG indexes **without a `#`** (1418 of the live reference's 3097 explicit templates, e.g.
  "Cannot be Frozen") is asked for by presence — `{ id }` with no `value`. Its compiled regex has no
  capture group, so reading a number gives `NaN`, which `JSON.stringify` writes as `"min": null`;
  GGG matches nothing against that, so a single such mod silently zeroed the entire search.
- Stat filters are **summed per stat id**, not one per mod line. An item can carry the same stat on
  several affixes (a real body armour had +144 and +49 Evasion Rating from two prefixes) and GGG
  indexes the total, so two filters for one id ask for an item that has 144 *and separately* 49.
- **A mod is searched partway down its own printed roll bracket, not at its exact roll**
  (`searchFloor()` in `shared/mod-rolls.ts`, `MOD_ROLL_FLOOR_RATIO` = 0.5). `16(6-16)%` asks for 11,
  `6(6-16)%` asks for 6.

  Pinning at the item's own number is the thing that made a good rare find nothing: it demands a roll
  at least this good on **every** mod at once, so the only matches are items strictly better than
  yours. Two real four-mod jewels measured **0** listings on all their mods, both of which the player
  found by hand in seconds by widening each stat. On the `Sapphire` this came from — 12(7-13) chaos
  damage, 4(2-4) cast speed, 22(15-25) curse duration, 9(8-12) curse AoE — the counts are: at the
  item's rolls **0**, at half **12**, at the bracket minimums **36**, and the player's own hand-drawn
  search returned 13.

  Half rather than either end, and a constant rather than a setting. At the bracket minimum the floor
  stops distinguishing a max roll from a minimum one of the same tier, which is what the in-game
  market does by default and is wider than this app wants; at the roll it demands perfection. Both
  real items now price on 4 of 4 mods in a single rung.

  Two things follow. **An unknown bracket floors at the roll**, which is the pre-feature query — every
  capture made without Advanced Item Descriptions, and everything in `loot-cache.json` from before it
  was parsed, so the absence costs specificity and never invents a wider search. And **the floor is
  never taken above the roll**, which a malformed bracket would otherwise do.
- The row editor can **override the roll each mod is searched at** (`PricedItem.modFilters`, and
  `pseudoFilters` for the aggregates), and the user's bound always wins over the computed floor.
  Three rules: a bound is never sent as `null` (the bare `{ id }` presence form is the only correct
  "no floor"); a `max` is emitted **only when every mod feeding that stat id supplies one**, since a
  ceiling summed from fewer affixes lands below the item's own total and excludes it from its own
  comparables; and a presence-only stat ignores bounds entirely. An empty box means different things
  on the two row kinds — a mod's min is prefilled with **the floor the search will use**, shipped on
  `GET_EDITOR_ROWS.modFloors` rather than recomputed in the renderer, so clearing it is a decision;
  an aggregate's is a placeholder showing the default floor, so an untouched one is not sent at all.
  Prefilling the *roll* there would both misreport the query and, on the next Reprice, send the roll
  back as a bound and silently undo the floor.
- **`extended.hashes` on each fetched listing names the stat ids that listing carries**, which is the
  only thing in GGG's response saying *which* filters a given listing satisfied. `countCoverage()`
  turns it into `PricedItem.statCoverage` — how many of the sampled listings held each mod — shown as
  a `9/10` chip per row in the editor. It costs no extra requests: the fetch already happens.
  **It is not "the mods the search used", and must never be presented as one.** Every rung is an `and`,
  so a listing it returned carries every mod the query demanded and those chips read `10/10` by
  construction — a row of ticks derived from them would be asserting nothing. Where the chip earns its
  place is on the rows the query did **not** demand: a mod the ladder dropped, or one GGG indexes no
  template for, whose count says how many of the priced listings carry it anyway and therefore whether
  losing it cost anything. It is counted over every stat the item's mods mapped to, not just the
  winning rung's. Groups are flattened before lookup, since a listing may carry the same stat as a
  crafted or fractured mod where this item has it as an explicit one.

  **The drop axis is the exception, and it answers the question from the other side.** A drop rung
  requires *all* of a named subset, so what it left out is known exactly — that is
  `PricedItem.autoDroppedMods`, which the row editor unticks and marks. The two coexist without
  contradicting each other because they say different things: `autoDroppedMods` names what the search
  removed, `statCoverage` measures what the listings carried among what remained. Don't collapse
  either into the other.
- **`PricedItem.searchedMods` is the third of that set, and it is what the row editor ticks.** The
  three answer three different questions and none replaces another: `autoDroppedMods` names what the
  drop axis removed, `statCoverage` **measures** what the returned listings held — informative only
  about the mods the query didn't demand — and this **names** what was sent, which is known exactly
  whichever rung won, because the request was built from it.

  It is assembled in `search()` from `bestFilters` — the winning rung's filters, tracked alongside
  `bestDropped` — mapped back through `modsByStat`, **plus the mods that reached the query by another
  route**: a pseudo aggregate's contributors when `!pseudoDropped`, and `buildStatFilters`'
  `defenceFolded` when `!defencesDropped`. Both arms are load-bearing in both directions. Counting
  them keeps a resistance roll or an armour mod ticked, which is honest — the 83% total and the
  armour floor genuinely are in the query. Dropping them when their group was retried away is equally
  honest, because then nothing about those rolls constrained the price.

  Before it existed the editor ticked everything but `ignoredMods` and `autoDroppedMods`, which
  overstated the search: a mod GGG's stat reference has no template for reaches no filter group at
  all, yet read as one the price rested on. Those rows now open unticked with a `not searched` badge.
  **Its wording must not blame GGG's reference specifically** — a contributor of a dropped aggregate
  lands in the same state for an entirely different reason, and the row cannot tell the two apart.

  **`undefined` means "no record", never "nothing was searched."** Nothing migrates
  `loot-cache.json`, and an item priced by poe.ninja or the exchange never ran a search; the editor
  falls back to its previous behaviour on absence rather than unticking every row. Written by both
  price paths, like every other field on that estimate — keep them in step.
- A **transient** failure (5xx or a thrown fetch) is retried `trade2.maxTransientRetries` times,
  each retry spending another budget slot; `4xx` and `429` never are. Without this a one-second GGG
  blip — a real capture caught `502` from trade2 *and* the currency exchange in the same second —
  stores the rare unpriced forever, which is indistinguishable from "this base has no market".
  There is still no *later* retry of items already persisted unpriced; that's the unstarted
  disk-cache/deferred-repricing work, and the row's Reprice button is the manual stand-in.
- The `corrupted` misc filter is applied **only when the item is corrupted**. Corrupted items are
  their own market and pricing one off uncorrupted listings overstates it; the reverse is a soft
  distinction, and demanding it measurably cost matches (1 result -> 0 on a real thin base).
- **A price floor rejects the dump end of the market** (`trade2.minListingPrice`, default **1**). Sent
  as `trade_filters.filters.price: { min }`, and 0 switches it off.

  **It carries no `option`, and reintroducing one is the bug this had.** That field names the currency
  a listing is *quoted in*, not a unit to compare against — so the `{ min: 1, option: "exalted" }` this
  used to send meant "listings priced in exalted orbs, at least 1" and silently discarded every
  divine-priced listing, i.e. the entire expensive end of every market. It looked fine precisely where
  it did no harm: cheap items are quoted in exalted and survive it. Measured on one real jewel query
  whose two matches were quoted at 1 and 10 divine —

  | filter | results | | filter | results |
  |---|---|---|---|---|
  | `{min: 1, option: "exalted"}` | 0 | | `{min: 1, option: "divine"}` | 2 |
  | `{min: 0.0001, option: "exalted"}` | 0 | | `{min: 1}` | 2 |
  | `{min: 999999}` | 0 | | `{min: 3000}` | 1 |

  — so a bare `min` is honoured and does compare across currencies. **Its unit is GGG's own and is not
  poe.ninja's:** the last two rows put one divine between 400 and 3000 of it, where poe.ninja's rate
  would call it 347 exalted. Near enough to exalted that the default of 1 still means roughly what it
  reads as, but don't document it as exalted and don't name a currency in the log.

  **It constrains the search, not the sample, and that is load-bearing.** `priceSample` takes the ten
  *cheapest* matches, so a floor applied after the fetch would find every one of them below it and
  leave nothing to price. Filtering server-side means the ten cheapest are the ten cheapest that clear
  the floor, and every listing count in the log counts the same set the price came from.

  **An item with nothing at or above the floor is stored unpriced, and there is no retry without it.**
  That is the difference from the defence and aggregate floors, which exist to widen a search that was
  too specific: this one exists to reject a market not worth recording, so retrying without it would
  hand back exactly the number it was set to suppress. The reason names the floor, via
  `describePriceFloor()`, for the same reason `listingsLabelFor` is shared — a message reporting no
  listings without naming the constraint sends the user to loosen mods that were never the problem.

  It exists because PoE2's cheap end is a wall of dump listings and `priceSample` reads that end
  deliberately: a real capture priced a rare at **0.09 chaos** where the same ten listings ran to
  0.6, which is not a price so much as evidence nobody is really selling one.
- **Listings with no asking price are excluded by sending nothing**, which is the one filter whose
  default state is an absence rather than a value. `trade2.saleType` is `"buyout"` by default and
  emits no `trade_filters` group at all; only the opt-out (`"any"`) sends
  `sale_type: { option: "any" }`. Measured live on an `Alpha Talisman` search: omitted 239 listings,
  `unpriced` 93, `any` 332 — exactly 239 + 93. GGG's `/api/trade2/data/filters` agrees, giving
  "Buyout or Fixed Price" the id `null`, i.e. the dropdown's untouched state. **Don't try to send
  that null explicitly** — `{ option: null }` is rejected with `400 Invalid sale type`, so there is
  no way to say "buyout" other than saying nothing. The default matters because the price is the
  cheapest of the *cheapest* matches (see `priceSample`) and an unpriced listing has no number to sort
  by; it can only take a slot a real asking price would have filled. This is the second knob after
  `listingStatus` that explains a gap between the app and the trade site.
- An armour piece is searched on its **defence totals**, via `equipment_filters`
  (`ar`/`ev`/`es`/`ward`, confirmed against `/api/trade2/data/filters`), and the local defence mods
  that produced those totals are **dropped from the stat filters** — see `isLocalDefenceMod()`.
  Without this a real Soldier Cuirass returned 0 listings on all 4 of its mod filters and 0 on 3,
  purely because `+186 to Armour` and `38% increased Armour` pinned rolls nobody else has; GGG
  indexes only the total they add up to. Keeping both would be strictly worse than either alone.
  Three things about it are load-bearing:
  - **A mod is only folded when the item actually displays that defence.** `+N to maximum Energy
    Shield` is local on a body armour and global on a ring — identical text, and the property line
    is the only thing that tells them apart. The shape patterns are also built from the defence
    names rather than "any words", or `10% increased Armour during Soul Gain Prevention` gets folded
    away and its stat searched by nothing.
  - **`min` sits below the item's own value** (`trade2.defenceMinRatio`, default 0.9) with no `max`.
    At parity the only matches are items strictly better, so the price describes something the item
    isn't. It also absorbs a skew that *cannot* be corrected exactly: GGG indexes these "including
    maximum quality" while the clipboard prints them at the item's current quality, and separating
    the base value from `increased%` needs a base-item table this app doesn't have. Don't "fix" that
    with a `× 1.2 / (1 + q/100)` factor — quality is additive with `increased%`, so on a +100% item
    that overstates the correction by ~10% and starts excluding real comparables.
  - **The defence floors are not part of the ladder** — they're always on, like base type. If every
    rung comes back empty the floor rung is retried **once** without them (`defencesDropped`), which
    is exactly the query this sent before the feature existed, so it can never invent a market.
  There is no `pseudo_total_armour`, no evasion and no ward — energy shield is the only defence GGG
  publishes a pseudo for — so `equipment_filters` is the only route to this and the pseudo
  aggregates below do not replace it.
- **A weapon is searched on its elemental DPS the same way** (`shared/weapon-stats.ts`,
  `trade2.useWeaponFilters`): `equipment_filters.edps`, the product of the printed `Elemental Damage:`
  ranges and `Attacks per Second:`, with the `Adds # to # Fire Damage` rolls that produced it folded
  out of the stat filters by `isLocalElementalDamageMod()`. Word for word the armour argument, one
  item class over — the game has already folded those rolls into the printed damage, and asking for
  them individually asks for a weapon nobody else has.

  **There is no elemental-damage pseudo to use instead.** Checked against the live
  `/api/trade2/data/stats`: PoE2's pseudo group is 36 entries of resistances, attributes,
  life/mana/energy shield, movement speed and mod counts — nothing about damage. `edps` is the only
  aggregate route there is, which is why this lives beside the defence filters rather than in
  `shared/pseudo-stats.ts`. Four things about it:
  - **It rides the same `DefenceFilter[]` list**, so the `defencesDropped` retry, `describeDefences()`
    and the `defenceFolded` → `searchedMods` accounting all cover it without a second mechanism.
  - **Its own switch, the shared floor.** `useWeaponFilters` is separate from `useDefenceFilters`
    because they are two features sharing a filter group, but the floor is `defenceMinRatio` — eDPS is
    a continuous stat like armour, so a second ratio would only ever hold the same number.
  - **No quality correction, unlike the defences.** Quality on a PoE2 weapon raises physical damage
    only, so the printed elemental damage is what a 0% copy of the base would show too.
  - **Only `Adds # to #` folds.** `#% increased Elemental Damage` does not move the printed line the
    way `#% increased Armour` moves the armour total, so folding it would delete a stat and put
    nothing in its place.
- **A waystone is searched on the totals it prints, and on nothing else**
  (`shared/map-stats.ts`, `trade2.useMapFilters`). `Item Rarity`, `Pack Size`, `Monster Rarity`,
  `Waystone Drop Chance`, `Revives Available` and `Monster Effectiveness` go into GGG's `map_filters`
  group ("Endgame Filters"); **every affix stat filter is dropped**, not folded mod-by-mod. Unlike
  armour there is no per-mod mapping to compute: a waystone's affixes are monster-difficulty mods and
  the printed block is what they produce *collectively*. Measured on a real T15 (`Ghost Frontier`) —
  its six affixes matched **0** listings, three of them matched 118, and its reward totals matched
  **3453**. Four things:
  - **`map_tier` is not sent.** The base type is per-tier (`Waystone (Tier 15)`) and already pins it:
    that type plus `map_tier: { min: 16 }` returns zero listings. `map_gold` and `map_experience`
    exist in the reference too, but nothing parses them — they aren't on the clipboard's property
    block.
  - **Monster Effectiveness is a `max`, and every other total is a `min`** — the one place a filter
    in this app points downward. This **reverses an earlier rule** that excluded it entirely, on the
    grounds that difficulty is a cost to the buyer so a floor would exclude the easier maps worth
    *more*. That was right about the direction and wrong about the remedy: the comparables are the
    waystones at **most** this dangerous, and sending nothing priced a 5% waystone against 50% ones.
    Revives keeps a floor — more attempts is a benefit. Don't "restore consistency" by making them
    all floors.
  - **The zero test is direction-aware, and the asymmetry is load-bearing.** `mapRowsOf` culls a
    floor of 0, which asks for nothing every listing doesn't already satisfy — that is what keeps a
    waystone printing `Revives Available: 0` from carrying a dead filter. A *ceiling* of 0 is kept:
    it is the best possible case and the one worth the most, so culling it would drop the constraint
    on exactly the waystones this exists to price. The row editor mirrors it, putting the computed
    placeholder on the **max** box for a `max` row and badging it `difficulty` rather than `reward`.
  - **The affix rows in the editor are disabled *and* unticked.** The backend sends no stat group for
    a waystone at all, so an enabled checkbox would promise a filter that never ships — and since
    `searchedMods` is empty for one, none of them ticks either, which says the same thing from the
    other side. That is why the Reprice readback skips `disabled` rows when building `ignoredMods`:
    a disabled box is not a decision the user made, and without the guard the first Reprice would
    convert every affix on the waystone into a permanent user exclusion.
- **Resistances, life, mana, attributes and global energy shield are searched as GGG's `pseudo`
  aggregates** (`shared/pseudo-stats.ts`, `trade2.usePseudoFilters`). Same argument as the defence
  filters, for the stats with no property line: three rolls pinned at +38 cold, +25 fire and +20
  lightning ask for a listing nobody has, while "83% total elemental resistance" is what GGG indexes
  and what the market prices. The contributing mods stop being individual stat filters, which
  shortens the ladder too. Seven rules are load-bearing:
  - **Derived, never matched.** A pseudo template is never on an item, so it cannot come from
    `TradeStatsMatcher` — the classifier is a table of anchored regexes over mod text, built from
    explicit name alternations rather than `.*` for the same reason `isLocalDefenceMod` is.
  - **An aggregate needs at least two contributing mods.** Folding a lone `+38% to Fire Resistance`
    into a *combined* total would match an item whose 38 is all cold — looser without being more
    accurate. `MIN_CONTRIBUTORS` holds the exception below; the number travels to the renderer on
    `PseudoStat.minContributors` rather than being a second copy of the rule in a plain `<script>`.
  - **The combined elemental total and the three single-element ones are alternatives, never both**
    (`chooseResistanceAggregate`). A per-element total wins when every resistance roll on the item
    names that same element, which is exactly where "58% total elemental" says less than the item
    does — it equally describes 20 fire / 20 cold / 18 lightning. An `all Elemental Resistances` roll
    feeds all three, so its presence hands the decision back to the combined total, which is honest:
    the item really does carry all three.

    **One contributor is enough for a per-element total**, and only there. The two-contributor rule
    exists because a lone fire roll folded into a combined total can silently be matched by cold;
    against `pseudo_total_fire_resistance` there is no such slippage — it is exactly what the mod
    says, and it *additionally* finds listings reaching that number through an all-elemental roll,
    which the explicit stat filter misses. Measured live on `Sapphire Ring`: explicit fire ≥ 42
    returned 9290 listings, the pseudo 10000+. A lone `to all Elemental Resistances` roll derives
    nothing — three filters from one mod would lengthen the ladder to say what its own explicit stat
    already says exactly.
  - **`to all Elemental Resistances` counts 3×**, and `to all Attributes` likewise. Counting it once
    understates a very common mod by two thirds.
  - **The contributing affixes' tiers ride along on `PseudoStat.contributors`**, and the row editor
    badges them onto the aggregate exactly as it does on a mod row — a total says nothing about
    whether it is one excellent roll or three mediocre ones. `syncFolding` rebuilds them from the
    *ticked* contributors along with the headline number, or a badge would credit the total to a roll
    it no longer includes.
  - **Energy shield is a pseudo only when the item displays no ES total.** Identical text is local on
    a body armour (already inside `equipment_filters.es`) and global on a ring; the property line is
    the only thing that separates them, exactly as in `isLocalDefenceMod`.
  - **The pseudo group is a second `stats` entry, never merged into the item's own** — confirmed live
    that GGG accepts two groups side by side (HTTP 200). It is always required, so it must not enter
    the reported `matchedMods`/`totalMods`, which go on counting real mod filters. The mod group
    stays at index 0. If every rung comes back empty the aggregates are dropped and retried once
    (`pseudoDropped`), before the defence retry.
- **A search is relaxed by dropping mods, never by lowering a threshold.** Every rung sends a subset
  of the item's filters as a **`type: "and"`** group and demands all of them. It carries no `value`
  at all, because there is no threshold to carry.

  It used to be a `count` whose `value.min` was always the number of *enabled* filters — the same
  demand, written in the shape that used to relax, which left it open whether a `disabled: true`
  filter counted toward the threshold. Measured live on one `Sapphire Ring` query with three enabled
  filters and two disabled: `count` with `min: 3`, `and` over the same five, and `and` over the three
  enabled alone all answered **4525**. So both group types ignore a disabled filter, and the shape
  changed without the demand changing.

  The count axis was removed on purpose and **must not come back**. "At least 4 of these 5" lets a
  listing miss *any* one mod — routinely the T1 roll that is the entire reason the item is worth
  anything — and since different listings satisfy different subsets, no set of mods can be reported
  back. It priced a different item and nothing on the row could say which. That is also why
  `statCoverage` exists at all, and why it stays a measurement rather than a row of ticks.
- One lookup walks a **ladder of drops**, assembled by `searchRungs()` and strictest first. It stops
  at the first rung holding at least `trade2.minListingsForMatch` listings, and only that rung is
  fetched — so a hit at the top costs one search, and each miss costs one more.
  - **The drop order is a total ordering in three bands** (`droppableFilters()`): known-weak first
    (tier at or past `modDropTierThreshold`, worst first), then mods whose tier the game didn't print,
    then known-good (T2 before T1). Shed what is known to be weak, then what nothing is known about,
    then what is known to be good.
  - **`modDropTierThreshold` orders rather than gates.** It used to forbid dropping a T1/T2 or an
    unknown-tier mod, which was safe only because the count axis sat behind it. With that gone a veto
    would strand a rare on a single all-mods rung — measured at **0 listings** for an ordinary
    five-mod rare — so everything is eventually droppable and the threshold only decides the order.
  - **Advanced Item Descriptions is no longer required for the ladder to work.** Without it every
    `ParsedMod.tier` is null, so the order falls back to the item's own order — degraded, not
    disabled. Tiers are what make the order *good*, which is still why both windows carry a note about
    the game option.
  - **`minModMatchRatio` is a floor, not a threshold** (`minSurvivingFilters()`): the fraction of the
    item's mods that must remain in the query. At 0.5 a five-mod rare never searches on fewer than
    three. Same arithmetic the old `requiredModMatches` used, making a stricter promise — every
    survivor is required, where before any N of them sufficed.
  - **Every rung produces a knowable mod set**, which is the whole point.
    `PricedItem.autoDroppedMods` names what left and `searchedMods` names what was asked for; the row
    editor unticks the former and ticks the latter, so reopening Edit shows the mods the price
    actually came from.
  - **A filter is ranked by its *best* contributor.** Filters are summed per stat id, so one can be
    fed by several mod lines (a hybrid affix is one roll printed as two), and dropping it drops all of
    them. Ranking by the worst would let a T5 line carry a T1 out of the search with it.
  - **`maxModDropSearches` (default 5) caps the requests**, `minModMatchRatio` caps the shedding, and
    the second is usually the binding one. A rare walking every rung can spend most of a rate-limit
    window by itself.
  - **The mods the ladder dropped are still sent, marked `disabled: true`.** GGG renders a disabled
    filter on the trade site as a present-but-unchecked row and **ignores it when matching**, so the
    "View search" link opens the whole mod table with the query's own mods ticked and the dropped ones
    visibly not. Verified live on both group types: a Sapphire Ring search matching 10000 on life
    alone still matched 10000 with a cold-resistance filter added as disabled, and 2465 with that same
    filter enabled. It constrains nothing and costs nothing. A mod GGG indexes no template for has no
    stat id, so it cannot appear even disabled — those are the rows the editor badges `not searched`.

  **The log is the diagnostic surface for all of this, and three lines carry it**: one naming what the
  search asked for mod by mod (`asking for <mod> >= <floor>; ...`), one per rung with its count, and
  one saying whether that count cleared `minListingsForMatch` and what the ladder did about it. The
  threshold is printed *next to the count it was compared against* on purpose — a rung with listings
  that carried on anyway reads as a bug otherwise, and `minListingsForMatch` is read once at boot, so
  a settings.json consulted afterwards can disagree with the value the running process holds. That
  exact confusion has come up repeatedly; the line exists so one capture settles it.

  Two rules are load-bearing:
  - **The strict rung is never walked past when it matched anything**, whatever
    `minListingsForMatch` says (`exactHit` in the loop). The rung that dropped nothing is the item
    itself rather than a relaxation of it: when listings carry its *whole* mod set, those listings
    **are** its comparables, and a looser rung prices a different item. The threshold governs rungs
    that shed something, and only those.

    This was four repeat bug reports. A real four-mod `Sapphire` had **9** listings carrying all four
    mods and was priced at 0.12 chaos off 147 sharing three, while the four-mod market started at 4
    divine — and the app reported it accurately, which is what made it look like a failed search
    rather than a threshold doing its job. Tying the outcome to the strict rung makes it independent
    of whatever value an install happens to hold, which is the half of the fix that can't regress.
  - **`minListingsForMatch` decides specificity versus sample depth for the *relaxed* rungs, and it
    defaults to 1** — stop at the first of them that matched anything. The measurement behind the
    higher bar is still real: the Ruby jewel this came from had 1 listing matching all 4 mods (30
    chaos), 9 matching 3 (1 divine), and 263 matching 2 (25 exalted — what sellers were actually
    asking). A thin *dropped* rung really can be one stranger's asking price, which is what the
    threshold is for. What used to make 1 workable is that the row printed a median next to the
    price, so a rung too thin to mean anything showed it rather than hiding behind a confident single
    number — **that signal no longer exists**, and this default is now less defended than it reads.
    See the price-and-parenthetical section below. **Don't re-raise the default on the strength of
    "the sample is small" alone** — small is
    the point now; it was changed deliberately after repeatedly pricing 4-mod rares off 2 of their
    mods, and **the change needed `adoptListingThresholdDefault` to reach existing installs at all**
    (see the Settings section).
  - **The floor rung is never dropped**, whatever caps apply, since it's the query that priced
    things before the ladder existed. If no rung clears the bar, the loosest non-empty one is used.
  - **`status` is not an online/offline toggle, and reading it as one was a real bug.** Confirmed
    against `/api/trade2/data/filters`, GGG's five options are `securable` (**Instant Buyout**),
    `available` (Instant Buyout and In Person), `online` (**In Person (Online)**), `onlineleague`, and
    `any`. The default is **`securable`**, because it is the only one matching what `priceSample`
    claims to report: a floor you can sell into *today*. An in-person listing needs the seller to
    answer a whisper, so it is not executable on demand. It is also not the narrower market it sounds
    like — measured live on a `Sapphire Ring` base, `online` returned 5678 listings and `securable`
    10000+.

    Every message wording follows the setting through `listingsLabelFor()`, shared by `listingsLabel`
    and `explainStrictMiss()`. The old code said "online listings" for everything but `any`, which
    sent a user to check whether sellers were online when the app had in fact excluded every
    instantly-buyable listing on the site. Never emit a bare "no listings": each option excludes
    something, and which one is the whole explanation for a gap against the trade site. Two real
    jewels matched **0** on all their mods and **16** / **5** once offline sellers were counted.
    `TradeEstimate.rungs` carries each threshold's count so the same function can separate "nobody has
    one" from "one person does, too thin to take a price from".
  `matchedMods`/`totalMods` ride along on `TradeEstimate` and are persisted as `PricedItem.modMatch`
  (optional — nothing migrates `loot-cache.json`), so the log, the reprice status text and the row
  badge can all say a price came from fewer than every mod. Don't drop that: the number looks
  equally confident either way.
- **The price is the market floor, on purpose — and the row reports two numbers, not one.**
  `priceSample()` takes the **cheapest** `trade2.maxListings` (default 5) of the price-ascending
  results, so the window is what undercutters are currently asking rather than what the item is
  nominally worth. Measured on a real Ruby jewel with 236 matching listings: ids 0-4 are `1 exalted`
  straight through, while ids 45-54 run 29-40 exalted, which is what that jewel was actually selling
  for.

  **`chaosValue` is the cheapest listing in that window** — the floor, i.e. what you can sell into
  today. The price stays the lower one for that reason. Don't collapse or raise it on the strength of
  "the prices look too low", because low is the specification: that would change what the number
  means, not just its accuracy, so it needs asking first.

  **The parenthetical beside it is the cheapest listing's age, not a second price.** A median of the
  same window used to sit there, on the argument that a floor far below it was one optimistic seller
  rather than a market. That was removed: the second number answered a question the reader rarely had,
  and how *stale* the floor is turned out to be the more useful annotation — the same figure three
  days old and an hour old are different facts about how much to trust it.

  **What that cost, and it is a real cost:** the row no longer signals a thin sample at all, so a
  price off one listing looks exactly like a price off twenty. `minListingsForMatch` defaulting to 1
  was partly justified by the median being visible (see above), and that justification is gone. The
  sample size survives only in the `[pricing] … cheapest of N sampled` log line. Putting the count on
  the row, or raising that default, are the two honest ways to close it.

  `listingIndexedAt` is carried on `TradeEstimate`, persisted as `PricedItem.tradeListingIndexedAt`
  (epoch ms, parsed once at the fetch), and printed as `12ex (listed 3d ago)` by `listedAgeEl()` in
  `common.ts`. Three things:
  - **It annotates a price, it never is one.** Nothing should read it through `effectiveChaosValue`.
    It sits where `tradeMedianChaosValue` did and keeps that field's one rule.
  - **It says "listed" rather than a bare age**, because the row already carries a relative time — the
    capture time on the line below. Two unlabelled `3d ago`s read as the same clock.
  - **`listedAgeEl` returns null wherever the parenthetical would assert something untrue** — a
    non-trade2 source, a manual override, an item stored before the field existed, a listing GGG sent
    no parseable date for, a folded group (the headline is a *sum* there), or an unpriced row. It is
    not in the `#panel.minimal` hide list: staleness matters in the heads-up form too.

  **`listing.indexed` is read structurally and has never been verified against a live response.** The
  app's `TradeListing` interface declares a fraction of what GGG sends — the `price` object carries a
  `type` the code explicitly discards — so the date is declared optional and an absent or unparseable
  one degrades to drawing nothing. If GGG renames it, every row silently loses the parenthetical
  rather than breaking.

  **Which unit the price is printed in comes from the listing, not from the number**
  (`pickDisplayUnit()` in `shared/format-value.ts`, mirrored in `common.ts`). The cheapest listing's
  own asking price is persisted as `PricedItem.tradeListingQuote`, and on `display.currency: "auto"`
  its currency is the unit the row shows: a price taken from a seller asking 2 chaos reads `2c`, which
  is what the market is quoting and what you would type into the trade site. Four things about it:
  - **The quote picks the unit; the number still comes from `chaosValue`.** Printing the seller's own
    amount would drift from the map total the moment the rates moved, and leave the row and the header
    disagreeing about one item.
  - **Only a single unfolded item follows its listing** (`rowQuote()`): `count > 1` is a summed group,
    `stackSize > 1` is a stack, and a manual price replaces the trade figure — in each the quote no
    longer describes the number on screen. Same guards as `listedAgeEl`, for the same reason: the
    quote, the date and the price all describe one listing or the row annotates a number with some
    other seller's details.
  - **A currency with no label falls back**, rather than printing a unit the header's rate line can't
    explain. Only `chaos`, `exalted` and `divine` are labelled.
  - **An explicit `display.currency` still wins outright.** The listing only decides `auto`.

  The magnitude fallback that covers everything else — poe.ninja prices, the exchange, the map total,
  folded stacks — now steps divine, then **chaos**, then exalted. Chaos used to be skipped entirely,
  which was defensible when one was worth ~48 exalted; at this league's rates one chaos is ~33 exalted,
  so skipping it turned every ordinary drop into a three-digit exalted figure.

  `TradeEstimate.matches` carries the full match count next to the sample size, so the log line and
  the reprice status both say which slice the numbers came from.

  The bias compounds with two others pointing the same way — the ladder settling on a rung looser
  than every mod, and GGG's search returning at most the 100 cheapest ids however many matched.
- Trade listings name currencies by GGG's **trade id** (`"exalted"`), not poe.ninja's display name
  (`"Exalted Orb"`). `currency-convert.ts` converts the three hub currencies from poe.ninja's
  `core.rates` block rather than by item lookup — exact, and unaffected by which categories were
  fetched — and returns null for anything it can't convert, so a bad conversion never lands as a
  confident price.

---

## Non-goals / do not "fix"

- No OAuth on trade2 calls (see the compliance section above) — the endpoint takes no token, and
  adding one silently breaks pricing rather than erroring.
- `TradeSearchBudget` declining a lookup rather than waiting out the rate limit is deliberate, and
  so is the resulting "some rares in a big map go unpriced". The alternative stalls all pricing. Those
  rows say **rate limited** rather than **unpriced**, which is the whole of the fix — don't "improve"
  it by making the queue retry them automatically, since the budget is per IP and shared with every
  other rare in the same map.
- **Rare** items and **Normal**-rarity base items go to trade2; Magic items never do, because PoE2
  glues prefix and suffix onto the base on one header line, so `ParsedItem.baseType` for them is the
  affixed name and there is nothing reliable to search on. That one is not an oversight in the
  resolver and has no fix available.
- A white base is priced on **item level and nothing else**, and is gated on it too
  (`trade2.useBaseItemSearch`, `trade2.baseItemMinLevel`, default 81). Four rules, all load-bearing:
  - **The gate lives in `Trade2Client`, not the resolver**, alongside the enabled and budget checks,
    so one place decides whether a lookup happens and one place words the refusal — which the
    unpriced log line then reuses verbatim. The resolver only widened its rarity test.
  - **The floor is the item's own level, exactly, with no ratio** — unlike `defenceMinRatio` and
    every other floor this sends. Item level is a discrete breakpoint rather than a continuous stat:
    0.9 of 82 is 73, which is a different market rather than a slightly wider one.
  - **`type_filters.filters.rarity: { option: "normal" }` is mandatory, not decoration.** Base type
    alone does not separate a white `Sacred Focus` from the rares on that same base, so without it a
    white item is priced off rare listings.
  - **No defence floors on a white base.** It has no affixes for one to be measuring, the base type
    already pins its defences — the same argument that keeps `map_tier` off a per-tier waystone —
    and the printed value moves with quality, so a floor taken off a 20% one silently excludes every
    0% listing of the identical base.

  The item-level gate exists for the rate limit, which is per **IP** and shared with every rare in
  the same map. White bases drop constantly and nearly all of them are worthless; below the floor
  nothing is requested at all. Don't remove it to "price everything".
- Not normalising defence totals to 20% quality is a limitation with no fix available here, not an
  oversight — it needs each base's own armour value to separate `(base + flat)` from `increased%`,
  and there is no base-item table in this app. `defenceMinRatio` covers the error; the approximate
  correction is worse than none (see the trade2 notes above).
- A rare on an illiquid base staying unpriced is a market fact, not a search bug. A real
  `Fists of Stone` capture had 7 of 7 matchable mods resolved correctly and still found nothing,
  because that base had **zero** online listings of any kind. Check base-type-only result counts
  before tuning filters in response to a report like that. Likewise a real Diamond jewel matched
  5640 listings on base type, 84 on any *one* of its four mods and **0** on any two — no threshold
  the ladder can reach would have priced it, because that mod combination isn't listed by anyone.

- Only a **partial** slice of GGG's 36-entry pseudo group is derived. The mod-count pseudos
  (`pseudo_number_of_prefix_mods` and friends) describe how craftable an item is, not what it sells
  for, and are left out on purpose rather than missed. Adding a pseudo means adding an anchored
  pattern and a multiplier, not loading the group into the matcher.
- Deriving a *combined* pseudo only when **two or more** mods feed it is deliberate: one contributor
  is not an aggregate. The three single-element resistance totals are the **stated exception** and
  derive from one roll — see the rule above for the measurement behind that, and don't "restore
  consistency" by taking them back to two.
- A waystone's affixes never becoming stat filters is the feature, not a gap — see the trade2 notes.
  Don't add an opt-in checkbox for them without first checking the listing count for that base, which
  was measured at zero. `trade2.useMapFilters` is the switch that already exists, and unticking it in
  the settings window restores the old affix search wholesale.
- Monster Effectiveness being a **ceiling** rather than absent reverses a former non-goal here; the
  reasoning is in the trade2 notes. Don't re-exclude it, and don't flip it to a floor.
- `statCoverage` counting per mod rather than naming "the mods that matched" is not a shortcut. Ticks
  derived from it would say nothing: every rung is an `and`, so the demanded mods are on every listing
  by construction. Its content is in the rows the query didn't demand. The ticks come from
  `searchedMods` and `autoDroppedMods` instead, which name what the query *asked for* — a different
  question, and one with an exact answer on every rung. The chip and the tick sit on the same row
  saying different things on purpose; don't reconcile them by deriving either from the other.
- **`autoDroppedMods` and `ignoredMods` are kept apart on purpose.** One is the app's guess,
  recomputed by every search; the other is the user's decision, recorded from the editor's checkboxes
  and re-sent on the next Reprice. Folding them into one list would make an automatic drop
  indistinguishable from a deliberate exclusion and permanent by accident. Same separation as
  `tradeMedianChaosValue` versus `manualChaosValue`: one annotates, the other replaces. A Reprice
  *does* convert an auto-drop into a user exclusion — the box was unticked when they pressed it — and
  overwrites `autoDroppedMods` wholesale so the two can never accumulate.
- **Don't reintroduce count relaxation** ("at least N of M") to widen coverage. It was removed
  deliberately: it prices an item that isn't this one and cannot say which, because different listings
  satisfy different subsets of the threshold. Dropping a named mod is the only relaxation whose result
  is reportable, which is what `autoDroppedMods` and `searchedMods` rest on. The cost is real — a rare
  whose surviving set nobody has listed stays unpriced — and that is the accepted trade.
- An unknown-tier mod being droppable **after** the known-weak rather than never is current design,
  and it reverses an earlier rule. That rule was safe only while the count axis sat behind it; with
  the count axis gone, refusing to drop leaves such an item unpriceable rather than cautiously priced.
  Don't infer a tier from the roll range — unknown still means unknown, it just no longer means
  "protected".
- Sending the dropped filters back as `disabled: true` is for the **search link**, not the search. It
  changes no result (verified live) and exists so "View search" shows the whole mod table. Don't
  "optimise" it away as redundant payload, and don't read a disabled filter as one the price rests
  on — `searchedMods` deliberately excludes them.
