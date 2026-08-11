# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Windows Electron overlay for Path of Exile 2 that prices loot as the player picks it up (via
PoE2's native Ctrl+C "copy item as text") and groups it into per-map "sessions" with running
totals. Not affiliated with or endorsed by Grinding Gear Games.

It puts **one** panel on screen, holding **one** list: a header with the current map's running
total and price freshness, then every item ever captured, newest first, searchable/sortable/
filterable, with per-row Edit (reprice, manual price) and a single Clear.

## Commands

```bash
npm run build     # tsc compile (src -> dist) + copy renderer assets (scripts/copy-assets.js)
npm run watch     # tsc --watch, no asset copy — run alongside a manual build for iterative work
npm test          # npm run build && node --test dist/test/*.test.js
npm start         # npm run build && electron .
npm run package   # npm run build && electron-builder --win --publish=never -> release/
```

There is no test filtering flag wired up; to run a single test file, build first then invoke node's
test runner directly against the compiled output, e.g.:
```bash
npm run build && node --test dist/test/store.test.js
```
Tests live in `src/test/*.test.ts` and run against compiled JS in `dist/test/`, using Node's
built-in `node:test` runner (not Jest/Vitest) — `describe`/`test`/`assert` from `node:test` and
`node:assert`.

Packaging on Windows requires Developer Mode enabled (electron-builder's `winCodeSign` step needs
symlink privileges); if it fails with a symlink/privilege error, that's the cause.

## Architecture

Standard Electron three-process split, but with no bundler for the renderer — the renderer loads
compiled JS as a plain `<script>` tag (see `src/renderer/index.html`), so **renderer code can only
use type-only imports from shared modules** (erased at compile time); it cannot `require()` or
import runtime values, since `contextIsolation` is on and `nodeIntegration` is off. Where a shared
helper is genuinely needed at runtime in both processes (e.g. `effectiveChaosValue` in
`shared/effective-value.ts`), it's duplicated as a small inline function in
`src/renderer/common.ts` with a comment explaining why, rather than restructured to be importable.

**The overlay is one renderer page**, `index.html`, loading `common.js` and then `index.js`.
`common.ts` holds the value/format helpers, `groupItems`, the row-fragment builders and the hover
tooltip; `index.ts` holds the page — header, the one list, the row editor, the toolbar. Because both
are plain scripts rather than modules, **tsc treats them as one global scope**: a top-level name
declared in both is a compile error (TS2451/TS2393), not a silent clash. Adding a page means adding
it to `scripts/copy-assets.js` too.

`setup.html`/`setup.ts` is the only other page (see the setup window below) and it is deliberately
**wrapped in an IIFE, declaring no top-level names at all** — that shared global scope spans every
renderer file, so a `const load = …` here would collide with the panel's the day it grows one. It
carries its own styles inline rather than through `style.css`, which describes a transparent
click-through panel and shares nothing with an ordinary form.

**The single list is the point, not an accident of layout.** It replaced three views of one dataset
— a 2-row live feed, a History browser of per-map drill-downs, and a second always-on-top window
showing the current map — where one item could appear in all three at once. `renderList()` rebuilds
it wholesale from `allItems`, coalesced to one rebuild per frame by `scheduleRender()`. Two things
that rebuild has to preserve by hand, both of which were bugs the moment the list stopped being
two rows long: `itemListEl.scrollTop` (a pickup mid-read would otherwise yank the user to the top),
and the open row editor, which is kept as a **live DOM node** in `openEditor` and re-appended rather
than rebuilt — a fresh editor each render would reset the mod checkboxes the user was unticking and
wipe the reprice status they were reading.

`useAsciiConsoleOnWindows()` (`src/main/console-encoding.ts`) is called first thing in
`src/main/index.ts`, before anything can log. Windows consoles run a legacy OEM codepage while Node
writes UTF-8, so an em dash in a log line prints as `ΓÇö` — on exactly the diagnostic messages
someone reads when something is wrong. It substitutes typographic punctuation **and folds accented
letters** (`Oisín` printed as `Ois├¡n`) at the console boundary, rather than relying on every future
log string being written in ASCII — PoE2 item names are not all ASCII, which this originally assumed.
Anything with no ASCII reading at all becomes a single `?` instead of a run of mojibake bytes.

**Main process wiring** (`src/main/index.ts`) is the composition root — everything is constructed
and connected here at `app.whenReady()`. Read this file first to see how the pieces below fit
together. It also calls `app.requestSingleInstanceLock()` before anything else: duplicate
instances would each load their own snapshot of `loot-cache.json` and clobber each other's writes
on save, and only one process can hold the OS-level global hotkey registrations.

**One overlay window** (`src/main/window.ts`): a full-screen transparent click-through sheet, with
the panel positioned by CSS inside it and sized from `overlay.panel`. There used to be a second,
*sized and movable* window for the full item list; it's gone, but the reason it was sized rather
than a second full-screen sheet is kept as a comment on `createOverlayWindow()` — two full-screen
always-on-top windows can't both be interactive, because whichever sits higher swallows every click
across the display and leaves the other's buttons dead. Don't reintroduce a second window without
reading that.

**The setup window** (`src/main/setup-window.ts`) is the one exception, and it is not the thing that
rule forbids. It is an ordinary framed, opaque, focusable, *not* always-on-top window, open only
while the user is configuring the app and never while they're playing, showing none of the loot
data — so it can't shadow the overlay's clicks the way a second full-screen sheet would. It exists
because `league`, `clientTxtPath` and `trade2.contactEmail` **cannot ship as working defaults**: the
league rotates every few months, and the other two belong to the machine and the person running it.
Before it existed the app shipped one contributor's email in the `User-Agent` of every user's GGG
requests. The overlay panel has nowhere sensible to ask for any of that, and `settings.json` in
`userData` is hand-edited JSON most users will never open.

Its three IPC channels are registered by `registerSetupIpcHandlers()`, **separately from and earlier
than** `registerIpcHandlers()`. That split is load-bearing: on first run setup has to run to
completion *before* the pricing clients are constructed, because they capture the league at
construction — and those clients are what `registerIpcHandlers` needs.

Saving from the tray's `Settings…` **relaunches the app** (`onSetupSaved` in `index.ts`, gated on
`bootCompleted`). The league is captured in closures in `index.ts` and again in each of
`PoeNinjaClient`/`Trade2Client`/`CurrencyExchangeClient`, so applying it live would take in some
places and not others. During first-run setup the same callback does nothing and boot simply
continues with the saved values. Note also that `window-all-closed` returns early while
`bootCompleted` is false — during first-run setup that window is the only one there is, and letting
it quit the app would kill the first launch every time.

**Overlay visibility** has several inputs (is PoE2 running, is PoE2 the foreground window, is the
overlay in interactive mode, did the user force it up from the tray), so the decision is factored out
into the pure `shouldShowOverlay()` in `src/main/overlay-visibility.ts`; `index.ts` holds the state
and calls `applyOverlayVisibility()` after mutating any of it. Add new inputs to the state object,
not as ad-hoc `show()`/`hide()` calls at the call site.
`applyOverlayVisibility()` keeps the latest decision in `desiredOverlay` and the deferred hide reads
it back, so a hide armed half a second ago can't take down a window that has since become wanted.
`ForegroundWatcher`
(`src/main/foreground-watch.ts`) supplies the foreground signal by spawning **one long-lived**
PowerShell helper that polls `GetForegroundWindow` internally and prints only on change — a per-poll
`execFile` like `ProcessWatcher` uses costs hundreds of ms and can't run at focus-tracking frequency.
Its script is passed as `-EncodedCommand` (base64 UTF-16LE) so the embedded C# here-string doesn't
have to survive Windows command-line escaping, and its stderr is **not** treated as failure —
powershell.exe emits a `#< CLIXML` preamble there on every healthy run once stderr is redirected.

Data flow, item capture to UI:
1. `ClipboardWatcher` (`src/main/clipboard-watch.ts`) polls `clipboard.readText()` every 150ms and
   fires a callback when the text changes and looks like an item (`starts with "Rarity:"`).
   **It deliberately never registers Ctrl+C as an Electron `globalShortcut`** — `globalShortcut`
   intercepts a key combo system-wide via the OS, which would stop PoE2 (the focused window) from
   ever receiving the keystroke, so the game would never write the item text to the clipboard in
   the first place. This was a real bug once; don't reintroduce a hotkey-based capture path.
   `forceCapture()` is the manual fallback bound to a hotkey (`Ctrl+\``) — it always fires even if
   the clipboard is unchanged, unlike the automatic poll.
2. `parseItemText()` (`src/parser/item-text-parser.ts`) turns the raw clipboard text into a
   `ParsedItem` (rarity/name/baseType/mods/etc.), splitting on `-{5,}` dashed section separators.
   Mod parsing is skipped entirely for Currency/Gem/Normal rarity to avoid false-positive matches
   against flavor text.

   **It must handle PoE2's "Advanced Item Descriptions" option**, which many players run with and
   which changes the mod format substantially. Three things it adds, all handled and none optional:
   - `{ Prefix Modifier "Polar" (Tier: 1) — Elemental, Cold }` grouping headers. These are not mods;
     they classify the lines *under* them, until the next header or the end of the section.
   - The roll range spliced into the number itself — `Attacks Gain 20(19-20)% of Damage`. GGG's stat
     templates carry a bare `#` and `TradeStatsMatcher` anchors end to end, so a range left in place
     matches **nothing**. This alone silently reduced every rare to a base-type-only trade search.
   - `Unmodifiable` and similar bare status keywords, which have no colon and would otherwise be
     offered as mods to tick off in the row editor.

   Mods carry a `ModKind` (`ParsedItem.mods`); `implicitMods`/`explicitMods` are flattened views of
   it, kept because they are what the store, the row editor and `ignoredMods` already use. Read
   through `modsOf()` (`src/shared/mods.ts`) — items persisted before `mods` existed have only the
   arrays, and nothing migrates `loot-cache.json` on load.

   It also reads the **defence totals** out of the property block into `ParsedItem.defences`
   (`Armour:`, `Evasion Rating:`, `Energy Shield:`, `Runic Ward:`). Those lines match
   `PROPERTY_LINE` and are skipped by `parseMods`, so they used to be discarded entirely — but they
   are the numbers GGG's trade API indexes, with every local mod and the item's quality already
   folded in by the game. Read them through `defencesOf()` (`src/shared/defences.ts`) for the same
   reason as `modsOf()`. `Runic Ward` is a distinct defence on runeforged bases, not a synonym for
   energy shield, and has its own filter id.
3. `ClientLogWatcher` (`src/main/logwatch.ts`) tails `Client.txt` for
   `[SCENE] Set Source [ZoneName]` lines (PoE2's actual zone-transition format — not PoE1's "You
   have entered X.") to auto start/end map sessions: entering a Hideout or the Atlas screen ends
   the current session, anything else starts a new one. It's a heuristic (campaign zones mid-run
   aren't distinguished), and skips the `(null)`/`(unknown)` placeholder lines that appear during
   loading transitions. Reads incrementally from the last known file offset, so it scales to
   Client.txt files of hundreds of MB without re-reading from the start.

   Two Windows behaviours dictate how it reads, both measured against a live 283 MB Client.txt
   while PoE2 held it open — **don't "simplify" either one away**:
   - `fs.stat()` reports a **stale size** for a file another process has open (it lagged the real
     length by ~250 bytes). So the reported size never bounds a read; `readSync`'s return value is
     the only trustworthy number and is what advances the offset. Size is consulted *solely* to
     detect truncation/rotation.
   - `fs.watch` doesn't reliably fire for buffered appends to that same open file, so a
     `logWatch.pollIntervalMs` interval is the real trigger and `fs.watch` is only an extra nudge.

   A trailing partial line is carried in memory (`pendingPartial`) rather than re-read, so a zone
   line straddling a read boundary is still seen exactly once — it used to be dropped silently.
   On start it backfills `logWatch.backfillBytes` to seed the *current* zone (at most one event, so
   history is never replayed as sessions). `logWatch.debugLogging` turns on per-poll byte/line
   tracing, which is the first thing to reach for when detection looks dead.

   **It is deliberately not gated behind `ProcessWatcher`.** Tailing a file costs nothing while the
   game is closed, and routing its start through process detection meant one stale executable name
   silently disabled map detection completely — which is exactly what happened once. Process
   detection governs overlay visibility and the clipboard watcher only.

   *Which* file it tails is settled by `resolveClientTxtPath()` in `index.ts` on top of
   `detectClientTxtPath()` (`src/main/poe2-install.ts`): Steam's install path out of the registry
   (`HKCU\Software\Valve\Steam` → `SteamPath`, then `HKLM\...\WOW6432Node` → `InstallPath`), the
   library roots out of `steamapps/libraryfolders.vdf`, then `steamapps/common/Path of Exile 2/
   logs/Client.txt` under each. PoE2's app id (**`2694490`**) only *orders* that search — the file
   existing on disk is what decides, so a stale or hand-edited vdf can't veto a real install. Two
   details are measured, not assumed: `SteamPath` comes back lowercased with forward slashes, and
   library paths in the vdf have their backslashes doubled. Detection also re-runs when a
   *configured* path has stopped existing, which is a player moving the game to another drive —
   otherwise map detection dies silently behind a path that looks perfectly fine in settings.json.
   Non-Steam installs fall to the setup window's Browse button; every failure here returns null
   rather than throwing, because "not found" is the ordinary case.

   `startLogWatcher()` is split out of the boot sequence and stops any existing watcher first, so a
   path chosen during first-run setup starts tailing without a restart. `lastZoneName` lives inside
   it and so resets per watcher — correct, since a new watcher backfills and re-announces the
   current zone.
4. `PriceResolver` (`src/pricing/price-resolver.ts`) tries `PoeNinjaClient` by item name first,
   then `CurrencyExchangeClient`, then falls back to `Trade2Client` (mod-aware search) for unpriced
   **Rares** — otherwise the item is stored with `priceSource: "unpriced"` and a logged reason.

   The resolver does **not** gate the trade2 call on availability or rate-limit budget; it calls
   unconditionally for Rares and `Trade2Client` short-circuits internally. That keeps one place
   deciding whether a lookup happens and one place wording the refusal, which is then reused
   verbatim by the unpriced log line and by the row editor's Reprice status text.

   The exchange is consulted when poe.ninja *misses* **or** when poe.ninja's data is older than
   `currencyExchange.stalePoeNinjaAfterMs` — the staleness arm is what covers poe.ninja being down,
   since a cached value would otherwise be served indefinitely with nothing to signal it. If the
   exchange also has nothing, a stale poe.ninja value is still preferred over no price at all.

   poe.ninja's exchange feed publishes only slug ids and no id->name metadata, so the lookup is
   inverted: `slugify()` rebuilds the id from the item name. Two things about that are measured, not
   assumed. Accents are **folded** (`Oisín's Oath` -> `oisins-oath`); without it `í` fell outside
   `[a-z0-9]`, became a separator, and produced `ois-ns-oath`, which matched nothing and left a real
   item unpriced. But poe.ninja is **not consistent** about this in its own ids — the same category
   ships `oisins-oath` *and* `mórrigans-insight` — so `slugVariants()` offers both spellings and
   `lookupCandidates()` probes each. Don't collapse it back to one.
5. `PricingQueue` (`src/pricing/queue.ts`) throttles resolution to one item per 250ms and persists
   the result via `db/store.ts`, then pushes it to the renderer over IPC.

**Persistence** (`src/db/store.ts`) is a hand-rolled JSON file store (`loot-cache.json` in
`app.getPath("userData")`) — not sqlite or lowdb. Both were tried and abandoned: `better-sqlite3`
needs native build tools the dev environment doesn't have, and `lowdb` is pure ESM which can't be
loaded from code compiled to CommonJS (`tsconfig.json` targets `module: "commonjs"`, and TS
downlevels dynamic `import()` to `require()` under that setting). Every session's
`totalChaosValue` is fully recomputed from its items (`recomputeSessionTotal`) rather than
incrementally maintained, so edits/repricing/manual overrides can't drift the total out of sync.
`effectiveChaosValue(item)` = `item.manualChaosValue ?? item.chaosValue` is the single source of
truth for "what is this item actually worth" — always read through it, never `chaosValue` directly.

**IPC surface** (`src/shared/ipc-channels.ts`, `src/main/ipc.ts`, `src/preload/index.ts`): pushes
(`PRICED_ITEM`, `SESSION_UPDATE`, `ZONE_STATUS`, `OVERLAY_STATUS`) go main -> renderer as items
resolve and totals change; pulls (`GET_STATUS`, `GET_HISTORY`, `GET_ALL_ITEMS`, `CLEAR_HISTORY`,
`REPRICE_ITEM`, `SET_MANUAL_PRICE`) are renderer-invoked `ipcMain.handle` calls. `REPRICE_ITEM`
always persists the caller's `ignoredMods` selection even if trade2 is unavailable or finds nothing,
so the user's mod-exclusion choices survive across repeated attempts. Both editing handlers return
the stored item *and* its recomputed session, which is what lets the renderer fold the result back
into `allItems` instead of re-fetching the list.

The setup window's three pulls (`GET_SETUP_CONFIG`, `BROWSE_CLIENT_TXT`, `SAVE_SETUP_CONFIG`) are
registered by `registerSetupIpcHandlers()` in `src/main/setup-window.ts`, not by `registerIpcHandlers`
— see the setup window above for why they can't share a call. They ride the **same preload**, which
exposes them as `window.poe2Setup` alongside the overlay's `window.poe2Overlay`; a second preload
would duplicate the wiring for three calls the panel never makes. `SAVE_SETUP_CONFIG` takes an
`onSetupSaved` callback for the same reason `CLEAR_HISTORY` takes `onHistoryCleared`: the handler
must not reach back into `index.ts`.

`GET_ALL_ITEMS` returns every item, unfiltered — the panel does its own grouping, sorting and
filtering client-side. `GET_HISTORY` survives solely so the header can name the current map on load;
nothing else is scoped to a session any more.

`OVERLAY_STATUS` carries the panel-wide state that isn't per-item — poe.ninja conversion rates, how
old the prices are, whether the overlay currently accepts clicks, and the panel's size — so the
renderer never has to infer any of it. `GET_STATUS` is the matching pull for initial load.

Handlers that mutate state the main process also holds take a callback rather than reaching back
into `index.ts`: `CLEAR_HISTORY` takes `onHistoryCleared` so `currentSession` can be nulled. Without
that, the next captured item is filed against a `sessionId` no session has, and
`recomputeSessionTotal()` skips it in silence.

**`CurrencyExchangeClient`** (`src/pricing/currency-exchange-client.ts`) reads GGG's public,
unauthenticated PoE2 Currency Exchange feed. Three things about it are measured behaviour, not
guesses — don't "simplify" them away:
- **The feed publishes an integer ratio pair normalized so the quote side is 1**, so the price of
  `a` in `b` is `ratio[b] / ratio[a]`. The direction is easy to invert silently; the guard is that
  derived chaos-per-divine must stay near poe.ninja's (`npm run verify:exchange-ids`).
- **The hour's low and high are collapsed with a geometric mean**, because a thin market can span
  6..28 per divine within one hour and the arithmetic mean sits far above any real trade.
- **Chaos is not the exchange's hub — exalted is**, ahead of divine, with chaos third. Items are
  therefore priced against whichever hub they trade with and converted, and the hub rates come from
  the exchange itself so the fallback doesn't depend on poe.ninja to interpret its own numbers.

`src/pricing/exchange-metadata-ids.ts` maps display names to the feed's internal metadata ids. This
**cannot** be derived from poe.ninja: its `image` field encodes an *art asset* path
(`2DItems/Currency/CurrencyVaal`) that often differs from the item's metadata id (`CurrencyCorrupt`),
agreeing for only ~2% of traded ids. Deriving it by price agreement doesn't work either — hundreds
of items sit within 10% of one another. Add entries by hand and confirm them with
`npm run verify:exchange-ids`, which prices each mapped id off the live feed and compares it against
poe.ninja. That check flags only errors that are *both* relatively and absolutely large: sub-exalted
items routinely disagree 2-3x between the two sources without either being wrong.

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
- GGG rate-limits trade2 **by IP, not by app** (`5:10:60,15:60:300,30:300:1800,600:21600:3600` —
  and a lookup costs two requests, search then fetch), so a second copy of the app, or a trade tool
  running alongside it, spends the same budget. `TradeStatsMatcher` also draws on it, though only
  once per run. (`CurrencyExchangeClient` does not — that feed is on `web.poecdn.com` under a
  different policy.) Defaults leave deliberate headroom; don't raise them to "use the full limit".
- The fetch endpoint rejects **more than 10 ids** with `400 {"error":{"code":2}}`, hence
  `MAX_FETCH_IDS`. Search takes the realm as a path segment (`/search/poe2/{league}`); fetch takes
  it as a query param (`?query={searchId}&realm=poe2`).
- `TradeStatsMatcher` fetches/caches GGG's public `/api/trade2/data/stats` reference and turns
  `#`-placeholder stat templates into regexes to match parsed mod text against stat IDs, used to
  build real mod-aware trade2 search filters instead of base-type-only search. **Each mod is looked
  up in its own `ModKind` group first**, then `explicit`, then `implicit`. That routing is
  load-bearing, not tidiness: by display text alone `crafted`, `fractured` and `desecrated` are
  100% subsets of `explicit` and `enchant` is 99%, so one pooled list would hand back an explicit
  stat id for a crafted mod almost every time — a filter for a different item. `pseudo` is
  deliberately not loaded (synthetic aggregates that never appear verbatim on an item).
- A stat GGG indexes **without a `#`** (1418 of the live reference's 3097 explicit templates, e.g.
  "Cannot be Frozen") is asked for by presence — `{ id }` with no `value`. Its compiled regex has no
  capture group, so reading a number gives `NaN`, which `JSON.stringify` writes as `"min": null`;
  GGG matches nothing against that, so a single such mod silently zeroed the entire search.
- Stat filters are **summed per stat id**, not one per mod line. An item can carry the same stat on
  several affixes (a real body armour had +144 and +49 Evasion Rating from two prefixes) and GGG
  indexes the total, so two filters for one id ask for an item that has 144 *and separately* 49.
- A **transient** failure (5xx or a thrown fetch) is retried `trade2.maxTransientRetries` times,
  each retry spending another budget slot; `4xx` and `429` never are. Without this a one-second GGG
  blip — a real capture caught `502` from trade2 *and* the currency exchange in the same second —
  stores the rare unpriced forever, which is indistinguishable from "this base has no market".
  There is still no *later* retry of items already persisted unpriced; that's the unstarted
  disk-cache/deferred-repricing work, and the row's Reprice button is the manual stand-in.
- The `corrupted` misc filter is applied **only when the item is corrupted**. Corrupted items are
  their own market and pricing one off uncorrupted listings overstates it; the reverse is a soft
  distinction, and demanding it measurably cost matches (1 result -> 0 on a real thin base).
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
    At parity the only matches are items strictly better, so the median prices something the item
    isn't. It also absorbs a skew that *cannot* be corrected exactly: GGG indexes these "including
    maximum quality" while the clipboard prints them at the item's current quality, and separating
    the base value from `increased%` needs a base-item table this app doesn't have. Don't "fix" that
    with a `× 1.2 / (1 + q/100)` factor — quality is additive with `increased%`, so on a +100% item
    that overstates the correction by ~10% and starts excluding real comparables.
  - **The defence floors are not part of the ladder** — they're always on, like base type. If every
    rung comes back empty the floor rung is retried **once** without them (`defencesDropped`), which
    is exactly the query this sent before the feature existed, so it can never invent a market.
  There is no `pseudo_total_armour`, so `equipment_filters` is the only route to this; the `pseudo`
  stat group stays unloaded (see `trade-stats.ts`).
- Searches use `stats` type **`count`** with a minimum, never `"and"` — see `requiredModMatches()`
  for the live measurements. Requiring every mod returns 0 listings for an ordinary four-to-six-mod
  rare, so `"and"` alone leaves essentially every rare unpriced.
- One lookup walks a **ladder** of thresholds (`modLadder()`), strictest first: all mods, one fewer,
  then `minModMatchRatio`'s floor. It stops at the first rung holding at least
  `trade2.minListingsForMatch` listings, and only that rung is fetched — so a hit at the top costs
  exactly what the old single search did, and each miss costs one more request. Two rules are
  load-bearing:
  - **A rung must describe a market, not just match.** The Ruby jewel this came from had 1 listing
    matching all 4 mods (30 chaos), 9 matching 3 (1 divine), and 263 matching 2 (25 exalted — what
    sellers were actually asking). "Strictest rung that matched anything" would have reported one
    stranger's asking price. The default bar is `maxListings`, i.e. enough to fill the sample the
    median is taken over.
  - **The floor rung is never dropped**, whatever caps apply, since it's the query that priced
    things before the ladder existed. If no rung clears the bar, the loosest non-empty one is used.
  - **Searches default to `status: online`, and every message wording follows the setting.** Two
    real jewels matched **0** online listings on all their mods and **16** / **5** with offline
    sellers counted — that gap is what makes the app look wrong next to the trade site, whose status
    filter the user may have cleared. `trade2.listingStatus` switches it; `listingsLabel` and
    `explainStrictMiss()` both key off it, so a search that counted offline sellers never reports
    "no online listings". `TradeEstimate.rungs` carries each threshold's count so the same function
    can separate "nobody has one" from "one person does, too thin to take a median over".
  `matchedMods`/`totalMods` ride along on `TradeEstimate` and are persisted as `PricedItem.modMatch`
  (optional — nothing migrates `loot-cache.json`), so the log, the reprice status text and the row
  badge can all say a price came from fewer than every mod. Don't drop that: the number looks
  equally confident either way.
- The median is taken over the **middle** of the price-ascending results (`medianWindow()`), not
  their cheap end. Taking the cheapest ten reports the *market floor*, not a price: PoE2's cheap end
  is a wall of 1-exalted dump listings, so every item with more than ten listings came back as
  1 exalted. Measured on a real Ruby jewel with 236 matching listings, ids 0-9 were ten straight
  `1 exalted` while ids 45-54 ran 29-40 exalted, which is what that jewel was actually selling for.
  `TradeEstimate.matches` carries the full match count next to the sample size so the log line and
  the reprice status both say which slice the number came from.
- Trade listings name currencies by GGG's **trade id** (`"exalted"`), not poe.ninja's display name
  (`"Exalted Orb"`). `currency-convert.ts` converts the three hub currencies from poe.ninja's
  `core.rates` block rather than by item lookup — exact, and unaffected by which categories were
  fetched — and returns null for anything it can't convert, so a bad conversion never lands as a
  confident price.

## Settings

`Settings` (`src/shared/settings.ts`) is loaded/saved via `src/main/settings.ts`, which copies
`config/settings.default.json` into `app.getPath("userData")/settings.json` on first run. On every
load, `mergeWithDefaults()` recursively fills in any key present in `config/settings.default.json`
but missing from the user's `settings.json` (and rewrites the file with the result), so an existing
install whose settings.json predates a schema change doesn't end up with `undefined` values at
runtime — it self-heals rather than needing a manual edit. When changing the `Settings` shape,
still update **both** `config/settings.default.json` and the type, so the merge has a default to
fall back to.

**Three keys ship blank or generic on purpose and must stay that way**, because the defaults file is
public and installed on other people's machines: `trade2.contactEmail` (`""` — it goes in the
`User-Agent` of every GGG request, so a real address here makes every user's traffic identify as
whoever committed it), `clientTxtPath` (`""` — machine-specific, detected or picked instead), and
`league` (a plausible current league, since it's only ever a prefill the user confirms). Don't
commit a working value for any of them. `setupCompleted` defaults to `false`, which is what makes
the setup window appear once — including for installs upgrading past the key, since
`mergeWithDefaults` fills it in.

## Known non-goals / do not "fix"

- No global hotkey for item capture (see ClipboardWatcher above) — this is deliberate, not missing.
- **One list, one window, one Clear.** There is no live feed, no History view, no session panel and
  no per-map drill-down; all of that was removed on purpose, because the same drop showed up in
  three places at once. Don't add a second list, a second view mode, or a second **overlay** window —
  grow the filters on the one list instead. Size it with `overlay.panel` if it's too small. The
  setup window is not a counterexample: it's framed, opaque and never on top, shows no loot data,
  and is closed while you play (see the setup window above).
- The list spans **every map ever recorded**, not the current one. A new map resets the header's
  running total and leaves the list alone; that's the design, not a failure to clear. It grows
  without bound until the user presses Clear.
- `groupItems` folding identical stackables across the whole list — so one row reads
  `Exalted Orb x214` — is what "one instance per item" means here. It deliberately refuses to fold
  anything with mods or a manual price, since those aren't interchangeable even when the names match.
- Foreground-window detection shelling out to PowerShell instead of using `active-win` /
  `node-window-manager` / `koffi` — those are native deps, ruled out for the same reason
  `better-sqlite3` was (see Persistence above). Electron exposes no foreground-window API.
- No OAuth on trade2 calls (see the compliance section above) — the endpoint takes no token, and
  adding one silently breaks pricing rather than erroring.
- `TradeSearchBudget` declining a lookup rather than waiting out the rate limit is deliberate, and
  so is the resulting "some rares in a big map go unpriced". The alternative stalls all pricing.
- Only **Rare** items go to trade2. Magic items are excluded because PoE2 glues prefix and suffix
  onto the base on one header line, so `ParsedItem.baseType` for them is the affixed name and there
  is nothing reliable to search on — not an oversight in the resolver.
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
- `ParsedItem.mods` duplicating `implicitMods`/`explicitMods` is deliberate — see the parser notes
  above. Don't "deduplicate" it by deleting the arrays; they are the persisted shape.
- `CurrencyExchangeClient` covering only currency-exchange-traded items, and therefore never pricing
  rares, is inherent to the data source. It is a fallback for poe.ninja, not a replacement for
  trade search.
- Partial coverage in `exchange-metadata-ids.ts` is deliberate: an unmapped name returns null and
  the item falls through to unpriced, whereas a wrong entry silently reports a different item's
  price. Omit ids you cannot verify.
- The map-session boundary heuristic (Hideout/Atlas = end, anything else = start) can misfire on
  campaign/town zones — this is a documented tradeoff, not a parsing bug, unless given a better
  signal to key off.
- `ClientLogWatcher` polling on an interval and ignoring the size `fs.stat()` reports is not
  redundancy to trim — both work around measured Windows behaviour (see the data-flow section).
- `logwatch.ts` not being started by `ProcessWatcher`, unlike the clipboard watcher, is deliberate.
- Steam detection shelling out to `reg query` rather than reading the registry through a native
  module is the same call as `ProcessWatcher` using `tasklist` — see the non-goal above about native
  dependencies. One registry read also doesn't justify the long-lived PowerShell helper
  `ForegroundWatcher` needs.
- The setup window saving via a **restart** rather than applying values live is deliberate; so is it
  covering only three settings. Everything else in `settings.json` is a tuning knob with a working
  default, and turning this into a full settings editor is a different feature from "the app can't
  run correctly until you answer these".
