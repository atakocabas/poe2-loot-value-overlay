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

**Renderer functions are testable despite exporting nothing**, which `item-groups.test.ts` is the
pattern for: it reads `dist/renderer/common.js`, runs it as a script in a `node:vm` context with a
stub `document` (that file's one top-level DOM read is `#item-tooltip`), and picks the function off
the context's global — which is how the page itself gets it. Use this rather than moving renderer
logic into `shared/` to make it importable: the plain-`<script>` constraint below is why it lives
there, and a second copy in `shared/` would drift from the one the panel actually runs.

Packaging on Windows requires Developer Mode enabled (electron-builder's `winCodeSign` step needs
symlink privileges); if it fails with a symlink/privilege error, that's the cause. The hosted Windows
runner in CI has those privileges, so this is a local-only obstacle.

`.github/workflows/ci.yml` runs `npm test` (which compiles first, so it covers type errors too) on
every PR into `main` and on `main` itself. The push half is **not** redundant with the release
workflow below: that one skips its whole body, tests included, whenever the version has already been
released — the common case — so without it a merge that doesn't bump the version would run nothing.
Both workflows are on `windows-latest`, because `poe2-install.test.ts` and `settings.test.ts` assert
against Windows paths that the code under test builds with `path.join`.

**Releases are cut by bumping the version, not by merging.** `.github/workflows/release.yml` runs on
every push to `main`, but its first step asks GitHub whether `v{package.json version}` has already
been released and stops there if it has — so ordinary merges pass through silently, and a merge that
changes the version runs `npm ci && npm test && npm run package` and publishes the NSIS installer and
the portable exe to a new release. The gate is deliberately "is this version released" rather than
"did this commit change package.json": it reads the same from a squashed merge, a re-run or a manual
`workflow_dispatch`. `gh release create` makes the tag itself, so there is no separate tagging step
that could disagree with it. Bump `package.json` **and** `package-lock.json` together (`npm version
<v> --no-git-tag-version`, which touches both — but check its diff, it reformats the `build` block).

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

`setup.html`/`setup.ts` and `settings.html`/`settings.ts` are the other two pages (see the two
windows below), and both are deliberately **wrapped in an IIFE, declaring no top-level names at
all** — that shared global scope spans every renderer file, so a `const load = …` on either would
collide with the panel's, and with each other. They share `form.css` and neither uses `style.css`,
which describes a transparent click-through panel and has nothing to say about an opaque form; the
handful of rules unique to one page stay inline on that page.

**The single list is the point, not an accident of layout.** It replaced three views of one dataset
— a 2-row live feed, a History browser of per-map drill-downs, and a second always-on-top window
showing the current map — where one item could appear in all three at once. `renderList()` rebuilds
it wholesale from `allItems`, coalesced to one rebuild per frame by `scheduleRender()`. Two things
that rebuild has to preserve by hand, both of which were bugs the moment the list stopped being
two rows long: `itemListEl.scrollTop` (a pickup mid-read would otherwise yank the user to the top),
and the open row editor, which is kept as a **live DOM node** in `openEditor` and re-appended rather
than rebuilt — a fresh editor each render would reset the mod checkboxes the user was unticking and
wipe the reprice status they were reading.

**The panel has two forms, and the resting one is the heads-up display.** Which is showing is the
single biggest thing to know about the renderer:

- **Minimal — the default, everywhere.** The **last drop** (`MINIMAL_ROWS`, currently 1), anything
  still being priced, and the map total *if* a map is running. Everything you can't use while playing
  is hidden by the `#panel.minimal` block in style.css — filters, Export/Clear, the disclaimer, the
  per-row Edit button — along with what you already know: which map you're in, and how old the prices
  are. Roughly 70-90px tall against ~390px expanded. `#panel` **ships with the class**, because this
  is the resting state and `setMinimalMode` starts from `true` and early-returns when unchanged.
- **Expanded — the `toggleList` hotkey, and nothing else.** The whole scrolling history, filters,
  footer, Edit. The handler in `index.ts` also flips `overlayInteractive`, because the point of the
  key is reaching those Edit buttons and leaving the two separate made it two keypresses every time.
  **Nothing else in the app changes the panel's form** — entering a map briefly did, via a
  `collapsePanel()` helper, and it was removed. The size is the user's business.

**Two things that used to be one.** `minimalMode` and the map total were both driven by
`applyMapState()`; they came apart when the form became a keypress:

- `applyMapState()` now owns **only** `#session-total-line`, and keeps `MAP_END_GRACE_MS` — it reacts
  to events, and chaining maps arrives as `SESSION_UPDATE(ended)` then `SESSION_UPDATE(new)` with
  real awaits between them, so without the grace the total blinks on every transition.
- `setMinimalMode()` is called from `applyStatus()` off `OverlayStatus.expanded`, with **no grace and
  no re-check** — a keypress is deliberate and should land immediately.

`#list-empty` is deliberately *not* in the `#panel.minimal` hide list. Minimal is now what a fresh
install opens in, and hiding it left an empty bordered box with nothing to say Ctrl+C is what fills
it; `syncEmptyNote()` already hides the note whenever there is a row.

The map test is `isMapSession()` (`shared/session.ts`), duplicated inline in the renderer as
`isInMap()` for the usual plain-`<script>` reason. It governs the total only. Rules:

- **An active session is not the same thing as a map**, and conflating them was a real bug. Every
  capture calls `ensureActiveSession()`, which opens a session so the item has somewhere to be filed
  — including when you Ctrl+C in a hideout. Testing `endedAt` alone therefore collapsed the panel to
  its one-row in-map form on any capture outside a map, until the next zone change closed it. A
  session counts as a map when it has a `zoneName` (it came from entering one) **or** `manual` is set
  (the toggle-session hotkey, i.e. the user saying so). `Session.manual` is optional because nothing
  migrates `loot-cache.json`; absent reads as false, which is the safe direction.
- **Minimal mode bypasses the filters entirely** (`minimalGroups()`, not `visibleGroups()`).
  `searchText`, `unpricedOnly` and `sortMode` persist while their controls are hidden, so a search
  left over from the last time the list was open would silently filter the one row away with nothing
  on screen to explain why. Minimal always means "the newest drop"; the filter state is untouched and
  returns with the full panel.
- **The hideout flag is not part of it.** A session opened by the toggle-session hotkey has
  `zoneName: null` and can be running while the player stands in their hideout, so folding
  `lastZoneIsHideout` in would close a map the user opened by hand. It refines the *label* for the
  inactive case — hideout versus atlas — and that is all.
- **`applyMapState()` shows immediately and hides on a delay**, re-checking the condition when the
  timer fires, exactly like `applyOverlayVisibility()` in the main process. See the grace note above
  for why the *form* deliberately has no equivalent.
- **`#session-total-line` ships `class="hidden"` and is revealed**, like `#rate-status`. Out of a map
  the first session the renderer sees is the *previous, ended* one, so shipping it visible would
  flash a finished map's total on every launch. Its visibility is toggled with `.hidden`, a bare
  `display: none` at specificity 0-1-0 — giving that element a `display` property in an id-keyed
  rule would silently disable the whole thing.

This also fixed a real disagreement: `renderSessionTotal` tested only that a session *existed* while
`renderSessionStatus` tested `endedAt`, so a finished map's final figure sat in the header
indefinitely, reading as a total that was still climbing.

**Pending captures are the one thing rendered outside that list**, in `#pending-list` directly above
it, from `pendingCaptures` — and they are deliberately **not** folded into `allItems`. Four things
assume everything in that array is a real stored item: `groupItems` keys stackables on
`name|priceSource`, so a pending row would form its own group and then *migrate* on completion,
reading as a row vanishing while another's count jumps; `renderList` restores `scrollTop` around a
wholesale rebuild, which rows appearing on their own schedule would misalign; the CSV export writes
the lot; and `priceSource` is a closed union the store persists. Keeping them apart also removes the
correlation problem entirely — main pushes the whole list, so the renderer never matches a pending
row against the `PricedItem` that replaces it.

Two numbers there are load-bearing. A **300ms grace period** before a row is drawn, because
poe.ninja and the currency exchange are synchronous cache lookups and without it every currency drop
strobes a placeholder for one frame. And a **250ms tick that runs only while something is pending**,
which advances the elapsed count and lets a row cross the grace threshold without another push —
`setInterval`, not rAF, for the same reason `scheduleRender` avoids it.

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

**The setup and settings windows** (`src/main/setup-window.ts`, `src/main/settings-window.ts`) are
the exception, and they are not the thing that rule forbids. Both are ordinary framed, opaque,
focusable, *not* always-on-top windows, open only while the user is configuring the app and never
while they're playing, showing none of the loot data — so neither can shadow the overlay's clicks
the way a second full-screen sheet would.

**They are two windows because the two halves of the configuration are applied in opposite ways**,
and that line is the whole reason for the split:

- **Setup** (`league`, `clientTxtPath`, `trade2.contactEmail`) **cannot ship as working defaults** —
  the league rotates every few months, and the other two belong to the machine and the person
  running it. Before it existed the app shipped one contributor's email in the `User-Agent` of every
  user's GGG requests. Saving **relaunches the app**, because the league is captured in closures in
  `index.ts` and again in each of `PoeNinjaClient`/`Trade2Client`/`CurrencyExchangeClient`, so
  applying it live would take in some places and not others.

  Both windows also carry a **static note about Advanced Item Descriptions**, which is a setting in
  the *game* and so has no field and nothing to save. It sits here because the option has to be on
  before an item is copied for its mod tiers to exist at all, and setup is the one page every install
  sees exactly once. Don't turn it into a checkbox — the app cannot set it.
- **Settings** (`hotkeys`, the `overlay` block, `display.currency`, `trade2.saleType`) all ship with
  working defaults and are **applied in place** — nothing downstream captured any of them.
  `onSettingsSaved` in `index.ts` **mutates the live `settings` object rather than rebinding it**,
  since `statusDeps`, `registerIpcHandlers` and the clipboard closure all hold that same object.
  Don't widen it to keys the clients captured; that's what the setup window is for. `trade2.saleType`
  is assigned **field by field** rather than as a block, because its neighbours *are* captured —
  `contactEmail` by `createPublicGggFetch`'s User-Agent and the budget numbers by
  `TradeSearchBudget`, both at construction — so replacing the whole `trade2` object would read as
  applied and silently not be.

The overlay panel has nowhere sensible to ask for any of this, and `settings.json` in `userData` is
hand-edited JSON most users will never open.

**The app's icon is geometry, not an image file.** `src/main/icon-art.ts` draws the mark — a gold
hexagonal gem cut by a chevron — into RGBA at any size, in a unit square, with 4x4 supersampling of
the finished composite rather than per-shape antialiasing. `icon.ts` wraps it as `NativeImage` for
the tray and the two framed windows' title bars (the overlay window is frameless and `skipTaskbar`,
so it has nowhere to show one), and `scripts/make-icons.js` runs after `tsc` in `npm run build` to
write `build/icon.ico` and `build/icon.png`, which is what `build.win.icon` points electron-builder
at. `build/` is generated and gitignored like `dist/`. Four things there are deliberate:

- **`icon-art.ts` and `icon-png.ts` must not import electron**, because the build script requires
  them out of `dist/` long before there is an app. Authoring the mark as an SVG instead would need
  `sharp`/`resvg` to rasterise, which are native modules — the same call as `better-sqlite3` and
  `active-win` — and committing seven hand-drawn PNGs means seven copies to drift.
- **Both consumers go through PNG**, hence the small encoder in `icon-png.ts`. Handing raw pixels to
  `nativeImage.createFromBuffer` means matching Skia's native BGRA-*premultiplied* order, which
  silently yields a plausible icon in the wrong hue rather than an error.
- **`renderIcon` simplifies below 32px** (`detailFor`): the specular and crown facet come off, the
  cut widens and the rim goes to full strength. They are sub-pixel at tray size and land as haze
  over the one thing that has to survive. It's the only place in that file that knows the size.
- **The rim is drawn before the cut**, so the cut runs through the girdle. The other order leaves the
  chevron's arms as stubs, and at 16px welds them into the outline — the mark becomes a dark smudge
  on a gold blob. For the same reason the .ico's 16/24/32 entries are the bare mark and only 48+
  carry the plate.

Setup's three IPC channels are registered by `registerSetupIpcHandlers()`, **separately from and
earlier than** `registerIpcHandlers()`. That split is load-bearing: on first run setup has to run to
completion *before* the pricing clients are constructed, because they capture the league at
construction — and those clients are what `registerIpcHandlers` needs. The settings window's two
channels have no such constraint and are registered alongside the overlay's. During first-run setup
`onSetupSaved` does nothing and boot simply continues with the saved values. Note also that
`window-all-closed` returns early while `bootCompleted` is false — during first-run setup that window
is the only one there is, and letting it quit the app would kill the first launch every time.

**The global hotkeys are suspended for as long as the settings window is open** — `onOpenSettings`
in `index.ts` calls `unregisterAllHotkeys()` before opening it and `applyHotkeys()` when it closes.
This is not tidiness. `globalShortcut` takes a combo from the OS system-wide, so a *bound*
accelerator never reaches any renderer and the key recorder simply cannot see it — the same
mechanism that rules out Ctrl+C as a capture hotkey. It also makes `probeAccelerator()` honest,
which would otherwise report every one of this app's own bindings as already taken. `onSettingsSaved`
therefore deliberately does **not** re-register: the window is still open at that point.

Two things in `index.ts` are restartable units for this, both shaped like `startLogWatcher()` (stop
first, take the fresh `settings`, tolerate the not-configured case): `applyHotkeys()` and
`startForegroundWatcher()`. The latter has to catch itself up — if `hideWhenGameUnfocused` is
switched on while PoE2 is already running, `ProcessWatcher`'s `started` event has long since fired
and won't start the new watcher for it.

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
     they classify the lines *under* them, until the next header or the end of the section. Two
     things are read off one: the leading word, which gives the `ModKind`, and `(Tier: N)`, which
     gives `ParsedMod.tier` and is the **only** source of affix tier anywhere in the app — GGG's stat
     reference publishes none. One header can cover several lines (a hybrid affix is one roll printed
     as two), and they share its tier as well as its kind, so both travel together. A trailing
     `(rune)`-style marker overrides the kind and takes the tier to null with it: a header that isn't
     describing this line's kind isn't describing its tier either.
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

   **The automatic path persists everything the estimate carries**, the same set `REPRICE_ITEM`
   writes. It used to keep six fields and drop `statCoverage`, `coverageSample`, `pseudoDropped` and
   `mapDropped` even though the search had already paid for them, so a freshly captured rare showed
   none of the badges the row is built to render until the user pressed Reprice once — which read as
   missing data rather than a lost write. `autoDroppedMods` is what made that asymmetry
   load-bearing: without it the row editor cannot show which mods produced an *automatic* price, and
   showing that is the reason the field exists. Keep the two write paths in step.

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

   **poe.ninja is not a GGG host and gets none of `ggg-fetch.ts`.** It publishes no rate limits and
   returns no `X-Rate-Limit-*` headers, so `GggRateLimiter` would have nothing to act on — there is
   nothing to measure and nothing to react to, which argues for restraint rather than against it.
   Two things stand in for it, neither optional:
   - **One pool across both category lists** (`inPool`, `poeNinja.maxConcurrentRequests`, default 4).
     A refresh is 23 requests and firing them together at a free community service behind Cloudflare
     is the pattern that gets an IP blocked. It must stay **one** pool: two under a `Promise.all`
     each honour the limit while the refresh runs at twice it — measured at 8 in flight for a
     configured 4. A bad value falls back to the default rather than reducing the limit to `NaN`,
     which emptied the batch and made a refresh silently fetch nothing.
   - **An identifying `User-Agent`**, via `appUserAgent()` shared with `createPublicGggFetch` so the
     string can't drift. It optional-chains `trade2.contactEmail`, since `PoeNinjaClient` otherwise
     has no reason to require that block.
5. `PricingQueue` (`src/pricing/queue.ts`) throttles resolution to one item per 250ms and persists
   the result via `db/store.ts`, then pushes it to the renderer over IPC.

   It also **owns the pending list** — everything captured but not yet priced — and pushes it whole
   on `PRICING_STATUS` at every transition, because until this existed the renderer had no idea an
   item existed until it was fully priced. That gap is long and silent: most of a rare's wall clock
   is `spendBudgetSlot()`'s bare `await sleep()` inside `TradeSearchBudget` spacing, which logs
   nothing and can run five times at `minSearchIntervalMs`. The stage comes from two places — the
   queue itself for `queued`/`pricing`, and the optional `onTradeSearch` callback on
   `PriceResolver.resolve()` for `trade2`, fired at the one point the work stops being a cache
   lookup. Retiring an entry happens **before** `onPriced`, so an item is never on screen twice, and
   it sits outside the try/catch: a thrown resolver that skipped it would leave a row up forever.

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
`GET_EDITOR_ROWS`, `REPRICE_ITEM`, `SET_MANUAL_PRICE`) are renderer-invoked `ipcMain.handle` calls.
`REPRICE_ITEM` always persists the caller's `ignoredMods`, `modFilters`, `pseudoFilters` and
`mapFilters` even if trade2 is unavailable or finds nothing, so the tuning the user just did survives
across repeated attempts. `GET_EDITOR_ROWS` supplies the editor rows that aren't mod lines — derived
aggregates and a waystone's reward totals — because both classifiers are tables of anchored regexes
and the renderer is a plain `<script>` that can't import shared modules at runtime. Each aggregate
carries its contributors' individual amounts so unticking one updates the total live, and the two
`minRatio` settings ride along rather than being duplicated as renderer constants that would
silently disagree once tuned. Both editing handlers return
the stored item *and* its recomputed session, which is what lets the renderer fold the result back
into `allItems` instead of re-fetching the list.

The setup window's three pulls (`GET_SETUP_CONFIG`, `BROWSE_CLIENT_TXT`, `SAVE_SETUP_CONFIG`) are
registered by `registerSetupIpcHandlers()` in `src/main/setup-window.ts`, not by `registerIpcHandlers`
— see the setup window above for why they can't share a call. The settings window's two
(`GET_SETTINGS_CONFIG`, `SAVE_SETTINGS_CONFIG`) come from `registerSettingsIpcHandlers()` in
`src/main/settings-window.ts`. All five ride the **same preload**, which exposes them as
`window.poe2Setup` and `window.poe2Settings` alongside the overlay's `window.poe2Overlay`; a second
preload would duplicate the wiring for five calls the panel never makes. They stay two bridges rather
than one because the windows apply their values in opposite ways, and one object offering both would
invite calling them together. Both save handlers take a callback — `onSetupSaved`, `onSettingsSaved`
— for the same reason `CLEAR_HISTORY` takes `onHistoryCleared`: the handler must not reach back into
`index.ts`.

`SAVE_SETTINGS_CONFIG` **validates and probes before it writes anything**. `validateAccelerator` and
`findDuplicateAccelerators` (`shared/accelerator.ts`, pure and unit-tested) reject a combo that could
never work, and nothing is persisted in that case — a half-written settings.json where three of four
hotkeys changed is harder to reason about than a form that visibly didn't take. `probeAccelerator`
then reports what the OS won't hand over, which *is* saved: the user may well want it once whatever
holds it is closed. An empty accelerator is valid everywhere and means **disabled**.

`GET_ALL_ITEMS` returns every item, unfiltered — the panel does its own grouping, sorting and
filtering client-side. `GET_HISTORY` survives solely so the header can name the current map on load
and decide which of the panel's two states to open in; nothing else is scoped to a session any more.
Note what it returns out of a map: the newest session, which is an **ended** one — the out-of-map
state has to be right from that, not only after a transition.

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
- The row editor can **override the roll each mod is searched at** (`PricedItem.modFilters`, and
  `pseudoFilters` for the aggregates). Without it every stat is pinned to the item's own number,
  which is the main reason a good item finds only items strictly better than itself. Three rules:
  a bound is never sent as `null` (the bare `{ id }` presence form is the only correct "no floor");
  a `max` is emitted **only when every mod feeding that stat id supplies one**, since a ceiling
  summed from fewer affixes lands below the item's own total and excludes it from its own
  comparables; and a presence-only stat ignores bounds entirely. An empty box means different things
  on the two row kinds — a mod's min is prefilled with its roll, so clearing it is a decision, while
  an aggregate's is a placeholder showing the default floor, so an untouched one is not sent at all.
- **`extended.hashes` on each fetched listing names the stat ids that listing carries**, which is the
  only thing in GGG's response saying *which* filters a given listing satisfied. `countCoverage()`
  turns it into `PricedItem.statCoverage` — how many of the sampled listings held each mod — shown as
  a `9/10` chip per row in the editor. It costs no extra requests: the fetch already happens.
  **It is not "the mods the search used", and must never be presented as one.** A `count` rung asks
  for at least N of M and different listings satisfy different subsets, so no such set exists there; a
  row of ticks would assert otherwise. Groups are flattened before lookup, since a listing may carry
  the same stat as a crafted or fractured mod where this item has it as an explicit one.

  **The drop axis is the exception, and it answers the question from the other side.** A drop rung
  requires *all* of a named subset, so what it left out is known exactly — that is
  `PricedItem.autoDroppedMods`, which the row editor unticks and marks. The two coexist without
  contradicting each other because they say different things: `autoDroppedMods` names what the search
  removed, `statCoverage` measures what the listings carried among what remained. Don't collapse
  either into the other.
- A **transient** failure (5xx or a thrown fetch) is retried `trade2.maxTransientRetries` times,
  each retry spending another budget slot; `4xx` and `429` never are. Without this a one-second GGG
  blip — a real capture caught `502` from trade2 *and* the currency exchange in the same second —
  stores the rare unpriced forever, which is indistinguishable from "this base has no market".
  There is still no *later* retry of items already persisted unpriced; that's the unstarted
  disk-cache/deferred-repricing work, and the row's Reprice button is the manual stand-in.
- The `corrupted` misc filter is applied **only when the item is corrupted**. Corrupted items are
  their own market and pricing one off uncorrupted listings overstates it; the reverse is a soft
  distinction, and demanding it measurably cost matches (1 result -> 0 on a real thin base).
- **Listings with no asking price are excluded by sending nothing**, which is the one filter whose
  default state is an absence rather than a value. `trade2.saleType` is `"buyout"` by default and
  emits no `trade_filters` group at all; only the opt-out (`"any"`) sends
  `sale_type: { option: "any" }`. Measured live on an `Alpha Talisman` search: omitted 239 listings,
  `unpriced` 93, `any` 332 — exactly 239 + 93. GGG's `/api/trade2/data/filters` agrees, giving
  "Buyout or Fixed Price" the id `null`, i.e. the dropdown's untouched state. **Don't try to send
  that null explicitly** — `{ option: null }` is rejected with `400 Invalid sale type`, so there is
  no way to say "buyout" other than saying nothing. The default matters because the price is a
  median of the *cheapest* matches (see `priceSample`) and an unpriced listing has no number to sort
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
    At parity the only matches are items strictly better, so the median prices something the item
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
- **A waystone is searched on the reward totals it prints, and on nothing else**
  (`shared/map-stats.ts`, `trade2.useMapFilters`). `Item Rarity`, `Pack Size`, `Monster Rarity` and
  `Waystone Drop Chance` go into GGG's `map_filters` group ("Endgame Filters"); **every affix stat
  filter is dropped**, not folded mod-by-mod. Unlike armour there is no per-mod mapping to compute:
  a waystone's affixes are monster-difficulty mods and the reward block is what they produce
  *collectively*. Measured on a real T15 (`Ghost Frontier`) — its six affixes matched **0** listings,
  three of them matched 118, and its reward totals matched **3453**. Three things not to "fix":
  - **`map_tier` is not sent.** The base type is per-tier (`Waystone (Tier 15)`) and already pins it:
    that type plus `map_tier: { min: 16 }` returns zero listings.
  - **Monster Effectiveness and Revives are parsed but never filtered.** They are difficulty, which
    is a cost to the buyer, so a `min` floor on them excludes the easier maps that are worth *more*.
  - **The affix rows in the editor are disabled, not merely unticked.** The backend sends no stat
    group for a waystone at all, so an enabled checkbox would promise a filter that never ships.
- **Resistances, life, mana, attributes and global energy shield are searched as GGG's `pseudo`
  aggregates** (`shared/pseudo-stats.ts`, `trade2.usePseudoFilters`). Same argument as the defence
  filters, for the stats with no property line: three rolls pinned at +38 cold, +25 fire and +20
  lightning ask for a listing nobody has, while "83% total elemental resistance" is what GGG indexes
  and what the market prices. The contributing mods stop being individual stat filters, which
  shortens the ladder too. Five rules are load-bearing:
  - **Derived, never matched.** A pseudo template is never on an item, so it cannot come from
    `TradeStatsMatcher` — the classifier is a table of anchored regexes over mod text, built from
    explicit name alternations rather than `.*` for the same reason `isLocalDefenceMod` is.
  - **An aggregate needs at least two contributing mods.** Folding a lone `+38% to Fire Resistance`
    into a total would match an item whose 38 is all cold — looser without being more accurate.
  - **`to all Elemental Resistances` counts 3×**, and `to all Attributes` likewise. Counting it once
    understates a very common mod by two thirds.
  - **Energy shield is a pseudo only when the item displays no ES total.** Identical text is local on
    a body armour (already inside `equipment_filters.es`) and global on a ring; the property line is
    the only thing that separates them, exactly as in `isLocalDefenceMod`.
  - **The pseudo group is a second `stats` entry of type `and`, never part of the `count` group** —
    confirmed live that GGG accepts both side by side (HTTP 200). It is always required, so it must
    not enter `modLadder()`'s arithmetic or the reported `matchedMods`/`totalMods`, which go on
    counting real mod filters. The `count` group stays at index 0. If every rung comes back empty the
    aggregates are dropped and retried once (`pseudoDropped`), before the defence retry.
- Searches use `stats` type **`count`** with a minimum, never `"and"` — see `requiredModMatches()`
  for the live measurements. Requiring every mod returns 0 listings for an ordinary four-to-six-mod
  rare, so `"and"` alone leaves essentially every rare unpriced.
- One lookup walks a **ladder** with two axes, assembled by `searchRungs()` and strictest first. It
  stops at the first rung holding at least `trade2.minListingsForMatch` listings, and only that rung
  is fetched — so a hit at the top costs exactly what the old single search did, and each miss costs
  one more request.
  - **The threshold axis** (`modLadder()`) keeps every filter and relaxes the `count` minimum: all
    mods, one fewer, then `minModMatchRatio`'s floor.
  - **The drop axis** (`droppableFilters()`, `trade2.useModDropLadder`) removes the item's *weakest
    named affixes* one at a time and requires all the survivors. The two ask different questions and
    the difference is the point: "4 of 5" lets a listing miss **any** mod, including the T1 roll that
    is why the item is worth anything, while dropping a named T5 filter asks for a specific, slightly
    worse item — which is how a player narrows a search by hand.
  - **Only the drop axis produces a knowable mod set**, and that is what makes
    `PricedItem.autoDroppedMods` possible at all where `statCoverage` is not (see below). A drop rung
    requires *all* of a named subset, so the mods left out of it are known exactly; the row editor
    unticks them, so reopening Edit shows the mods the price actually came from.
  - **The drop axis needs mod tiers, which need Advanced Item Descriptions.** PoE2 prints `(Tier: N)`
    in the affix headers only under that option. Without it every `ParsedMod.tier` is null,
    `droppableFilters()` returns `[]`, and `searchRungs()` degenerates to `modLadder()` rung for
    rung — which is why the feature costs nothing for players who don't run it, and why the setup and
    settings windows both carry a note about the game option. **Unknown tier is never droppable**, at
    any threshold: the ladder sheds a mod only on positive evidence that it's the weak one.
  - **A filter is ranked by its *best* contributor.** Filters are summed per stat id, so one can be
    fed by several mod lines (a hybrid affix is one roll printed as two), and dropping it drops all of
    them. Ranking by the worst would let a T5 line carry a T1 out of the search with it.
  - **The drop axis has its own cap** (`maxModDropSearches`, default 5) rather than sharing
    `maxModLadderSearches`, because it is the more expensive one — a rare walking every rung can spend
    most of a rate-limit window by itself. It never empties the filter set; one always survives.

  Two rules are load-bearing on both axes:
  - **`minListingsForMatch` decides specificity versus sample depth, and it now defaults to 1** —
    stop at the first rung that matched anything. The measurement that argued the other way is still
    real and worth knowing: the Ruby jewel this came from had 1 listing matching all 4 mods (30
    chaos), 9 matching 3 (1 divine), and 263 matching 2 (25 exalted — what sellers were actually
    asking). At a high bar the ladder walks past the exact item to reach a market; at 1 it reports the
    exact item off however few listings carry it. Both are defensible and the setting is the seam.
    What makes 1 workable is that the row prints `medianChaosValue` next to the price, so a rung too
    thin to mean anything shows it rather than hiding behind a confident single number. **Don't
    re-raise the default on the strength of "the sample is small" alone** — small is the point now;
    it was changed deliberately after repeatedly pricing 4-mod rares off 2 of their mods.
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
    one" from "one person does, too thin to take a median over".
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

  **`chaosValue` is the cheapest listing in that window; `medianChaosValue` is its median.** Both are
  carried on `TradeEstimate`, the median is persisted as `PricedItem.tradeMedianChaosValue`, and the
  row prints them as `12ex (18ex)` via `medianValueEl()` in `common.ts`. The gap between the two is
  the whole point of showing both: a floor far below the median of its own five listings is one
  optimistic seller, not a market, and no single number can say that. The price stays the lower one
  because a floor is what you can sell into today.

  Two things follow, both deliberate. **The map total sums the floors**, since `chaosValue` is what
  `recomputeSessionTotal` reads — so the headline on a row and the total in the header agree, which
  they would not if the row led with one figure and the total summed another. And
  **`tradeMedianChaosValue` annotates a price, it never is one**: nothing should read it through
  `effectiveChaosValue` or sum it. It sits next to `manualChaosValue` in `PricedItem` and does the
  opposite thing — that one *replaces* the price.

  Don't collapse this back to a single number on the strength of "the prices look too low", because
  low is the specification; and don't promote the median back to the price. Either would change what
  the number means, not just its accuracy, so it needs asking first. The median is still worth taking
  over a mean for the reason it was originally chosen: one unconverted-currency or misplaced outlier
  among five would drag a mean, and the cheap end is exactly where those live.

  `medianValueEl` returns null wherever the parenthetical would assert something untrue — a non-trade2
  source, a manual override, an item stored before the field existed, a folded group (the headline is
  a *sum* there), or the two figures agreeing. It is not in the `#panel.minimal` hide list: the pair
  is wanted in the heads-up form too.

  `TradeEstimate.matches` carries the full match count next to the sample size, so the log line and
  the reprice status both say which slice the numbers came from.

  The bias compounds with two others pointing the same way — the ladder settling on a rung looser
  than every mod, and GGG's search returning at most the 100 cheapest ids however many matched.
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

**Which keys the settings window may edit is a rule, not a list.** `SettingsConfig`
(`shared/types.ts`) is `hotkeys`, the editable part of `overlay`, `display.currency` and
`trade2.saleType` — everything nothing downstream captured, which is exactly what can be applied
without a relaunch. Adding a key there means checking that no client, closure or watcher read it at
construction; if one did, it belongs to the setup window and its restart instead. `trade2.saleType`
qualifies on exactly that test and is worth reading as the worked example: `Trade2Client` holds the
same `Settings` object `index.ts` mutates and reads `this.settings.trade2.saleType` while building
each query, so a save reaches the very next lookup. Most of that block does **not** qualify. `loadDefaultSettings()` backs the per-field
Reset buttons, so "default" in the window means the same thing it means to `mergeWithDefaults`
rather than a second set of constants in the renderer.

## Known non-goals / do not "fix"

- No global hotkey for item capture (see ClipboardWatcher above) — this is deliberate, not missing.
- **One list, one window, one Clear.** There is no live feed, no History view, no session panel and
  no per-map drill-down; all of that was removed on purpose, because the same drop showed up in
  three places at once. Don't add a second list, a second view mode, or a second **overlay** window —
  grow the filters on the one list instead. Size and place it with `overlay.panel` if it's too small
  or in the way — which the settings window now does, so "make the panel bigger" and "move it off my
  minimap" are user actions rather than code changes. `panel.position` is horizontal only (`left`
  applies a `#panel.left` class that flips the base rule's `right: 24px`); the panel stays
  bottom-anchored because that's the direction `maxHeightPercent` grows in. The setup and settings windows are not counterexamples: both are framed, opaque and never
  on top, show no loot data, and are closed while you play (see those windows above).
- Pending rows living outside `#item-list`, and outside `allItems`, is not a layout accident — see
  the note above. They are also **not filtered or sorted**: they're transient, few, and ordered by
  the queue they're actually in. Don't "fix" that by routing them through `visibleGroups()`.
- The list spans **every map ever recorded**, not the current one. A new map resets the header's
  running total and leaves the list alone; that's the design, not a failure to clear. It grows
  without bound until the user presses Clear.
- The map total **disappearing** the moment a map ends is the feature, not a lost figure — there are
  two panel states and that line belongs to one of them. Don't "improve" it by keeping the finished
  map's total up as "Last map: N": the total would then be on screen almost always, which is the
  behaviour this replaced.
- The heads-up form showing **one** drop is the chosen number, not a placeholder. `MINIMAL_ROWS` is a
  renderer constant precisely so it stays cheap to retune; `overlay.minimalRows` in the settings
  window is the obvious home if it ever needs to be per-user.
- **Edit is hidden in minimal mode, not omitted.** The row stays single-shaped in `renderItemRow`
  and CSS hides the button, so there is no second row builder to keep in sync. The hover tooltip
  still works, so the item is still readable at a glance; the `toggleList` hotkey is how you reach it.
- **The panel's form is the hotkey's business and nothing else's.** It is never opened *or* closed
  for you: leaving a map doesn't expand it, and entering one doesn't collapse it. Both of those
  existed and were removed in turn — auto-expanding in the hideout first, then `collapsePanel()` on
  map entry. Don't reintroduce either; a panel that resizes itself while you play is the thing this
  arrived at.
- **`toggleList` flipping `overlayInteractive` too is the feature.** Expanding the list to press Edit
  is useless while the panel still passes clicks through, and `toggleOverlay` remains for the times
  you want click-through toggled without resizing anything.
- `groupItems` folding identical stackables across the whole list — so one row reads
  `Exalted Orb x214` — is what "one instance per item" means here. It deliberately refuses to fold
  anything with mods or a manual price, since those aren't interchangeable even when the names match.
  **A group carries its newest member**, which is load-bearing rather than arbitrary: `group.item` is
  what `minimalGroups()` sorts the heads-up form by, what `visibleGroups()` sorts by under sort=time,
  and what the row prints as "Ns ago". Keeping the first one seen meant a repeat pickup folded into a
  group still dated from the original drop, so re-picking up a currency you already had left the
  heads-up showing an *older* item as the last drop. `count` and `total` were right the whole time,
  which is what made it look like a pricing fault instead of a sorting one.
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
- Only a **partial** slice of GGG's 36-entry pseudo group is derived. The mod-count pseudos
  (`pseudo_number_of_prefix_mods` and friends) describe how craftable an item is, not what it sells
  for, and are left out on purpose rather than missed. Adding a pseudo means adding an anchored
  pattern and a multiplier, not loading the group into the matcher.
- Deriving a pseudo only when **two or more** mods feed it is deliberate, and so is the resulting
  "an item with one resistance roll searches it individually". One contributor is not an aggregate.
- A waystone's affixes never becoming stat filters is the feature, not a gap — see the trade2 notes.
  Don't add an opt-in checkbox for them without first checking the listing count for that base, which
  was measured at zero.
- `statCoverage` counting per mod rather than naming "the mods that matched" is not a shortcut: on a
  `count` rung the set it would name doesn't exist. Don't turn it into ticks. The ticks that *are*
  there come from `autoDroppedMods`, which the drop axis knows because it chose the subset itself.
- **`autoDroppedMods` and `ignoredMods` are kept apart on purpose.** One is the app's guess,
  recomputed by every search; the other is the user's decision, recorded from the editor's checkboxes
  and re-sent on the next Reprice. Folding them into one list would make an automatic drop
  indistinguishable from a deliberate exclusion and permanent by accident. Same separation as
  `tradeMedianChaosValue` versus `manualChaosValue`: one annotates, the other replaces. A Reprice
  *does* convert an auto-drop into a user exclusion — the box was unticked when they pressed it — and
  overwrites `autoDroppedMods` wholesale so the two can never accumulate.
- The drop axis doing nothing without **Advanced Item Descriptions** is the designed degradation, not
  a gap to paper over. Don't infer a tier from the roll range, or treat unknown as droppable: both
  turn "no information" into a confident decision to shed one of the item's mods.
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
- The setup window saving via a **restart** rather than applying values live is deliberate, and so is
  it covering only three settings. Don't "unify" it with the settings window: the restart is the
  honest way to apply a league three clients captured at construction, and a single dialog would have
  to restart for every change or lie about which ones need it.
- The settings window covering **only** hotkeys, the overlay block, the display currency and
  `trade2.saleType` is the same rule from the other side, not an unfinished job. Everything else in `settings.json` is a
  tuning knob with a working default that no UI has to exist for. The bar for adding a field is "can
  this be applied in place", not "is this configurable" — see the Settings section above.
- **Hotkeys are suspended while the settings window is open, and re-registered when it closes.** Not
  an oversight in the live-apply path: a bound accelerator is taken by the OS before any renderer
  sees it, so the recorder could not otherwise capture a combo that is already in use. Don't
  "improve" this by re-registering on save.
- A refused accelerator being **saved anyway** is deliberate. `globalShortcut.register` returning
  false means the combo is unavailable *right now*, usually because another app is running; refusing
  to store it would make the user's choice depend on what happened to be open at the time.
