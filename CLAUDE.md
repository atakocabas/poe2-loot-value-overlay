# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Windows Electron overlay for Path of Exile 2 that prices loot as the player picks it up (via
PoE2's native Ctrl+C "copy item as text"). Not affiliated with or endorsed by Grinding Gear Games.

It puts **one** panel on screen, holding **one** list: a header with price freshness, then every
item ever captured, newest first, searchable/sortable/filterable, with per-row Edit (reprice,
manual price) and a single Clear.

## Commands

```bash
npm run build     # tsc compile (src -> dist) + copy renderer assets (scripts/copy-assets.js)
npm run dev       # build, run, and restart the app on every change — the iterative loop
npm run watch     # tsc --watch alone: type-checking with no rebuild or restart loop
npm test          # npm run build && node --test dist/test/*.test.js
npm start         # npm run build && electron .
npm run package   # npm run build && electron-builder --win --publish=never -> release/
```

`npm run dev` (`scripts/dev.js`) is the loop to reach for: one full build, then `tsc --watch`
alongside a watcher on `src/renderer/*.html|css` that re-runs `copy-assets.js` — tsc knows nothing
about those files, so without it a markup or style edit silently does nothing. A change under `dist/`
restarts Electron wholesale, debounced so one emit is one restart. Four things there are
load-bearing, three of them about *this* app and one about watching files on Windows at all:

- **The respawn waits for the old process's `exit`.** `index.ts` takes
  `app.requestSingleInstanceLock()`, so a replacement spawned while the old copy is still shutting
  down loses the lock and quits immediately — which reads as the app vanishing, not restarting.
- **The kill is `taskkill /T`, not `child.kill()`.** `ForegroundWatcher` spawns its PowerShell helper
  as an ordinary non-detached child and stops it from `will-quit`; Node's kill is `TerminateProcess`,
  which runs no `will-quit` and leaves children behind, so a plain kill orphans one polling
  PowerShell per restart.
- **The watch runs `--noEmitOnError`**, unlike `npm run build`. A compile error then emits nothing,
  `dist/` keeps the last good build, and the running app stays up instead of being restarted into
  half-typed code. It is also what gates the first launch: nothing starts, and nothing watches
  `dist/`, until tsc's own opening full emit has landed — an app started before it is restarted by
  it a second later.
- **Every watch event is checked against the file's mtime.** libuv subscribes to
  `FILE_NOTIFY_CHANGE_LAST_ACCESS` among others, so *reading* a file fires `fs.watch` — and the app
  reads `dist/renderer/*.html|css` on every launch, which was measured restarting it a second time
  for a file nothing had written. `copy-assets` reads the sources for the same reason. Without the
  mtime test each restart arms the next one; it only *looked* stable because NTFS updates access
  times at most hourly.

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
Both workflows are on `windows-latest`, because `settings.test.ts` asserts against Windows paths that
the code under test builds with `path.join`.

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

- **Minimal — the default, everywhere.** The **last drop** (`MINIMAL_ROWS`, currently 1) and anything
  still being priced. Everything you can't use while playing is hidden by the `#panel.minimal` block
  in style.css — the whole header, filters, the footer buttons, the disclaimer, the per-row Edit
  button. Roughly 70-90px tall against ~390px expanded. `#panel` **ships with the class**, because
  this is the resting state and `setMinimalMode` starts from `true` and early-returns when unchanged.
- **Expanded — the `toggleList` hotkey, and nothing else.** The whole scrolling history, filters,
  footer, Edit. The handler in `index.ts` also flips `overlayInteractive`, because the point of the
  key is reaching those Edit buttons and leaving the two separate made it two keypresses every time.
  **Nothing else in the app changes the panel's form.** The size is the user's business.

`setMinimalMode()` is called from `applyStatus()` off `OverlayStatus.expanded`, with **no grace and
no re-check** — a keypress is deliberate and should land immediately.

`#list-empty` is deliberately *not* in the `#panel.minimal` hide list. Minimal is what a fresh
install opens in, and hiding it left an empty bordered box with nothing to say Ctrl+C is what fills
it; `syncEmptyNote()` already hides the note whenever there is a row.

**Minimal mode bypasses the filters entirely** (`minimalGroups()`, not `visibleGroups()`).
`searchText`, `unpricedOnly` and `sortMode` persist while their controls are hidden, so a search left
over from the last time the list was open would silently filter the one row away with nothing on
screen to explain why. Minimal always means "the newest drop"; the filter state is untouched and
returns with the full panel.

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

- **Setup** (`league`, `trade2.contactEmail`) **cannot ship as working defaults** — the league
  rotates every few months, and the contact address belongs to the person running it. Before it
  existed the app shipped one contributor's email in the `User-Agent` of every
  user's GGG requests. Saving **relaunches the app**, because the league is captured in closures in
  `index.ts` and again in each of `PoeNinjaClient`/`Trade2Client`/`CurrencyExchangeClient`, so
  applying it live would take in some places and not others.

  Both windows also carry a **static note about Advanced Item Descriptions**, which is a setting in
  the *game* and so has no field and nothing to save. It sits here because the option has to be on
  before an item is copied for its mod tiers to exist at all, and setup is the one page every install
  sees exactly once. Don't turn it into a checkbox — the app cannot set it.
- **Settings** (`hotkeys`, the `overlay` block, `display.currency`, `trade2.saleType` and
  `trade2.listingStatus`) all ship with working defaults and are **applied in place** — nothing
  downstream captured any of them.
  `onSettingsSaved` in `index.ts` **mutates the live `settings` object rather than rebinding it**,
  since `statusDeps`, `registerIpcHandlers` and the clipboard closure all hold that same object.
  Don't widen it to keys the clients captured; that's what the setup window is for. The two `trade2`
  keys are assigned **field by field** rather than as a block, because their neighbours *are*
  captured — `contactEmail` by `createPublicGggFetch`'s User-Agent and the budget numbers by
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

**The release check notifies and updates nothing** (`src/main/update-check.ts`). `UpdateChecker`
asks GitHub's `/releases/latest` at boot and every `updates.checkIntervalMs` (6h), compares the tag
against `app.getVersion()` with `isNewerVersion()` (`shared/version.ts`, pure and unit-tested), and
reports a newer one exactly once. It is constructed **last** in `whenReady`, after
`processWatcher.start()`: it is the only thing at boot talking to a host the app doesn't need in
order to work. Five things:

- **There is no `electron-updater`, and adding one is not a small change.** One of the two shipped
  targets is a **portable** exe with no install to replace; neither binary is code-signed, so a
  silent background install puts a SmartScreen prompt where the user can't answer it; and
  `release.yml` uploads `release/*.exe` only — `latest.yml` is written locally and never published.
  It also names its asset with hyphens (`PoE2-Loot-Value-Overlay-Setup-0.2.0.exe`) where the artifact
  on disk has spaces, which GitHub rewrites on upload, so an updater would additionally need an
  `artifactName`. **The release workflow needs no change for the notify path**, which is half the
  argument for it: `gh release create --generate-notes` already produces the `tag_name` and
  `html_url` this reads.
- **It uses plain `fetch`, not `createPublicGggFetch`.** Same argument as poe.ninja above — GitHub is
  not a GGG host and `GggRateLimiter` has nothing to learn from it. It sends its own
  `PoE2LootValueOverlay/{version}` and **deliberately does not reuse `appUserAgent()`**, which
  appends `trade2.contactEmail` because *GGG's policy* asks for a contact. GitHub asked for nothing,
  and reusing the string would put the user's own address in a request to a service that never
  wanted it. `fetchImpl` is constructor-injected so the tests need no network, like
  `CurrencyExchangeClient`.
- **`check()` never rejects.** Offline, a captive portal and a spent unauthenticated rate limit are
  all the ordinary case, and it is called from the boot chain whose `.catch` logs `[startup] failed`
  — an escaping rejection would report the whole app as having failed to start. `isNewerVersion()`
  answers false for anything it can't parse for the same reason from the other side: an unattended
  six-hourly check must not invent an update out of a tag it couldn't read.
- **Two surfaces, and the tray is the persistent one.** `createTray` now returns a `TrayHandle` with
  `setUpdateAvailable()`, since Electron's `Menu` is immutable once built — the template moved into a
  closure so the two forms can't drift, and `index.ts` holds the handle it used to discard. The
  panel's `#update-status` rides `OverlayStatus.update` and **is in the `#panel.minimal` hide list**:
  an update notice isn't actionable mid-map, and hiding it there also means the button is only ever
  on screen while the panel is interactive, so it can never look live while clicks pass through.
  There is no row when there's no update — a permanent disabled "You're up to date" is a line every
  user reads on every launch to learn nothing.
- **The URL is opened in `index.ts` and nowhere else.** `tray.ts` takes an `onOpenReleases` callback
  and imports no `shell`; `OPEN_RELEASES_PAGE` takes **no argument**, reading the URL back off
  `getStatus().update` in `ipc.ts`. Same rule as `OPEN_TRADE_SEARCH`, one step stronger — that URL
  this app assembles itself, while this one comes from GitHub's API, so letting it round-trip through
  a page would be the only place `shell.openExternal` is reached with a string a renderer touched.

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
   which changes the mod format substantially. Four things it adds, all handled and none optional:
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
     It is stripped from `text` but **kept** on `ParsedMod.rollRange`, from the line's *first* number
     — the one the matcher captures and filters on. That bracket is the only thing separating "rolled
     the top of its tier" from "rolled the bottom", and `searchFloor()` is what reads it.
   - `Unmodifiable` and similar bare status keywords, which have no colon and would otherwise be
     offered as mods to tick off in the row editor.
   - **The headers are authoritative, not merely tolerated.** Once an item prints any of them the
     game has named every affix it has, so `parseMods` treats an unnamed line as prose and drops it:
     a jewel's "Place into an allocated Jewel Socket ...", a waystone's map device line, a unique's
     flavour text. This replaced a blocklist that was growing one wording per item class, and had
     already missed the jewel line twice over — no colon, so `PROPERTY_LINE` skipped it, and the
     "Right click" phrase is only its *second* sentence, so the click guard skipped it too.

     Three things about the gate are load-bearing. It is armed **per item, not per section**: those
     description lines sit in their own trailing section with no header in it, so a per-section test
     finds no headers there and goes on treating every one of them as an affix — the exact bug. A
     line carrying a `(rune)`-style **suffix is exempt**, because a rune prints no header of its own
     and that marker is the only thing identifying it; without the exemption every runeforged item
     silently loses its rune, which is far worse than the stray line the gate exists to drop. And
     `isKnownNonModLine` **stays** — it is the whole guard for a capture made *without* the option,
     where there are no headers to believe.

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

   The same goes for a weapon's `Elemental Damage:` and `Attacks per Second:` lines, into
   `ParsedItem.weapon` and read through `weaponStatsOf()` (`src/shared/weapon-stats.ts`). Two
   differences from the defences: the damage line carries **one range per element**, comma separated,
   so it is scanned for `N-M` pairs and averaged rather than read with a single capture; and neither
   number is a filter on its own — their product is, as `equipment_filters.edps`.
3. `PriceResolver` (`src/pricing/price-resolver.ts`) tries `PoeNinjaClient` by item name first,
   then `CurrencyExchangeClient`, then falls back to `Trade2Client` (mod-aware search) for unpriced
   **Rares** — otherwise the item is stored with `priceSource: "unpriced"` and a logged reason.

   **The automatic path persists everything the estimate carries**, the same set `REPRICE_ITEM`
   writes. It used to keep six fields and drop `statCoverage`, `coverageSample`, `pseudoDropped` and
   `mapDropped` even though the search had already paid for them, so a freshly captured rare showed
   none of the badges the row is built to render until the user pressed Reprice once — which read as
   missing data rather than a lost write. `autoDroppedMods` is what made that asymmetry
   load-bearing: without it the row editor cannot show which mods produced an *automatic* price, and
   showing that is the reason the field exists. `searchedMods` is now the same argument again, and
   the more visible one — it is what the editor's checkboxes read, so dropping it here would leave an
   automatically priced rare ticking every mod while a repriced one ticked only what it searched.
   Keep the two write paths in step.

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
   Three things stand in for it, none optional:
   - **One pool across both category lists** (`inPool`, `poeNinja.maxConcurrentRequests`, default 4).
     A refresh is 23 requests and firing them together at a free community service behind Cloudflare
     is the pattern that gets an IP blocked. It must stay **one** pool: two under a `Promise.all`
     each honour the limit while the refresh runs at twice it — measured at 8 in flight for a
     configured 4. A bad value falls back to the default rather than reducing the limit to `NaN`,
     which emptied the batch and made a refresh silently fetch nothing.
   - **An identifying `User-Agent`**, via `appUserAgent()` shared with `createPublicGggFetch` so the
     string can't drift. It optional-chains `trade2.contactEmail`, since `PoeNinjaClient` otherwise
     has no reason to require that block.
   - **One refresh at a time** — `refresh()` hands every caller the promise already in flight rather
     than starting a second pull. Each concurrent call would open its *own* pool, so two overlapping
     refreshes run at twice the configured concurrency: the same failure the single pool guards
     against, by another route. It only became reachable when the panel grew its **Refresh prices**
     button (`REFRESH_PRICES`), whose press can land on the 10-minute timer's tick or on a previous
     press — and it is what gives that button its "already refreshing" behaviour for nothing. The
     handler reports success as `getLastRefreshAt()` having *moved*, reusing the existing rule that
     only a pull which actually returned prices counts, so "the request finished" and "there are new
     prices" stay distinguishable. A failure is reported in the button's own label, like the Clear
     button's confirm step: this window is frameless and non-focusable, so a native dialog can end up
     behind the game.
4. `PricingQueue` (`src/pricing/queue.ts`) throttles resolution to one item per 250ms and persists
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
downlevels dynamic `import()` to `require()` under that setting). The store holds one flat `items`
array and nothing else. `effectiveChaosValue(item)` = `item.manualChaosValue ?? item.chaosValue` is
the single source of truth for "what is this item actually worth" — always read through it, never
`chaosValue` directly.

A `loot-cache.json` written before map sessions were removed still carries a top-level `sessions`
array and a `sessionId` on every item. Nothing migrates it and nothing reads them; the extra keys
ride along unread, which is how every other dropped field is handled here. Don't write migration
code for it.

**IPC surface** (`src/shared/ipc-channels.ts`, `src/main/ipc.ts`, `src/preload/index.ts`): pushes
(`PRICED_ITEM`, `PRICING_STATUS`, `OVERLAY_STATUS`) go main -> renderer as items resolve; pulls
(`GET_STATUS`, `GET_ALL_ITEMS`, `CLEAR_HISTORY`, `GET_EDITOR_ROWS`, `REPRICE_ITEM`,
`SET_MANUAL_PRICE`, `REFRESH_PRICES`) are renderer-invoked `ipcMain.handle` calls.
`REPRICE_ITEM` always persists the caller's `ignoredMods`, `modFilters`, `pseudoFilters` and
`mapFilters` even if trade2 is unavailable or finds nothing, so the tuning the user just did survives
across repeated attempts. `GET_EDITOR_ROWS` supplies the editor rows that aren't mod lines — derived
aggregates and a waystone's reward totals — because both classifiers are tables of anchored regexes
and the renderer is a plain `<script>` that can't import shared modules at runtime. Each aggregate
carries its contributors' individual amounts so unticking one updates the total live, and the two
`minRatio` settings ride along rather than being duplicated as renderer constants that would
silently disagree once tuned. `modFloors` rides along for the same reason and one sharper one: it is
what the mod rows' min boxes prefill from, so without it a Reprice with untouched boxes would send the
item's own rolls back as bounds and undo `searchFloor()` entirely. Both editing handlers return
the stored item, which is what lets the renderer fold the result back into `allItems` instead of
re-fetching the list.

The setup window's two pulls (`GET_SETUP_CONFIG`, `SAVE_SETUP_CONFIG`) are registered by
`registerSetupIpcHandlers()` in `src/main/setup-window.ts`, not by `registerIpcHandlers` — see the
setup window above for why they can't share a call. The settings window's two
(`GET_SETTINGS_CONFIG`, `SAVE_SETTINGS_CONFIG`) come from `registerSettingsIpcHandlers()` in
`src/main/settings-window.ts`. All four ride the **same preload**, which exposes them as
`window.poe2Setup` and `window.poe2Settings` alongside the overlay's `window.poe2Overlay`; a second
preload would duplicate the wiring for four calls the panel never makes. They stay two bridges rather
than one because the windows apply their values in opposite ways, and one object offering both would
invite calling them together. Both save handlers take a callback — `onSetupSaved`, `onSettingsSaved`
— so the handler never reaches back into `index.ts`.

`SAVE_SETTINGS_CONFIG` **validates and probes before it writes anything**. `validateAccelerator` and
`findDuplicateAccelerators` (`shared/accelerator.ts`, pure and unit-tested) reject a combo that could
never work, and nothing is persisted in that case — a half-written settings.json where three of four
hotkeys changed is harder to reason about than a form that visibly didn't take. `probeAccelerator`
then reports what the OS won't hand over, which *is* saved: the user may well want it once whatever
holds it is closed. An empty accelerator is valid everywhere and means **disabled**.

`GET_ALL_ITEMS` returns every item, unfiltered — the panel does its own grouping, sorting and
filtering client-side.

`OVERLAY_STATUS` carries the panel-wide state that isn't per-item — poe.ninja conversion rates, how
old the prices are, whether the overlay currently accepts clicks, which of the panel's two forms it
is in, and the panel's size — so the renderer never has to infer any of it. `GET_STATUS` is the
matching pull for initial load.

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
- **A declined lookup is marked on the item, not just logged** — `TradeEstimate.rateLimited`, persisted
  as `PricedItem.unpricedReason: "rateLimited"` by both write paths, and shown on the row as a
  **rate limited** badge in place of **unpriced** (`sourceBadge` in `common.ts`, the value text in
  `renderItemRow`). The two states are opposites dressed the same: "unpriced" is a finding about the
  item — the market has nothing matching it, and waiting changes nothing — while this one means no
  search ever went out and the answer arrives on its own. Four things:
  - **It is a flag on the estimate, not a pattern match on `reason`.** That string is user-facing prose
    that gets reworded; four separate call sites produce a rate-limited outcome (budget spent up
    front, budget spent mid-ladder before the looser rungs, a transient failure with no slot left to
    retry, and GGG answering 429) and they share no wording.
  - **It is deliberately not a fifth `priceSource`.** That field says where a price *came from*, and a
    rate limit is not a source. `explainUnpriced` already separates four situations and only this one
    resolves by waiting, so a reason field scales where a source member wouldn't.
  - **`REPRICE_ITEM` writes it outside its priced-only conditional**, so it is cleared as well as set.
    An item rate-limited an hour ago and since priced would otherwise keep the badge for good.
  - **Absent is the fallback, and it reads as "nothing more to say".** Nothing migrates
    `loot-cache.json`, which is the honest direction here — a rate limit old enough to predate the
    field has long since expired.
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
  deliberately: a real capture priced a rare at **0.09 chaos** against a median of 0.6 over the same
  ten listings, which is not a price so much as evidence nobody is really selling one.
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
    threshold is for. What makes 1 workable is that the row prints `medianChaosValue` next to the
    price, so a rung too thin to mean anything shows it rather than hiding behind a confident single
    number. **Don't re-raise the default on the strength of "the sample is small" alone** — small is
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

  One thing follows, deliberately: **`tradeMedianChaosValue` annotates a price, it never is one**.
  Nothing should read it through `effectiveChaosValue` or sum it. It sits next to `manualChaosValue`
  in `PricedItem` and does the opposite thing — that one *replaces* the price.

  Don't collapse this back to a single number on the strength of "the prices look too low", because
  low is the specification; and don't promote the median back to the price. Either would change what
  the number means, not just its accuracy, so it needs asking first. The median is still worth taking
  over a mean for the reason it was originally chosen: one unconverted-currency or misplaced outlier
  among five would drag a mean, and the cheap end is exactly where those live.

  `medianValueEl` returns null wherever the parenthetical would assert something untrue — a non-trade2
  source, a manual override, an item stored before the field existed, a folded group (the headline is
  a *sum* there), or the two figures agreeing. It is not in the `#panel.minimal` hide list: the pair
  is wanted in the heads-up form too.

  **Which unit that pair is printed in comes from the listing, not from the number**
  (`pickDisplayUnit()` in `shared/format-value.ts`, mirrored in `common.ts`). The cheapest listing's
  own asking price is persisted as `PricedItem.tradeListingQuote`, and on `display.currency: "auto"`
  its currency is the unit the row shows: a price taken from a seller asking 2 chaos reads `2c`, which
  is what the market is quoting and what you would type into the trade site. Four things about it:
  - **The quote picks the unit; the number still comes from `chaosValue`.** Printing the seller's own
    amount would drift from the map total the moment the rates moved, and leave the row and the header
    disagreeing about one item.
  - **Only a single unfolded item follows its listing** (`rowQuote()`): `count > 1` is a summed group,
    `stackSize > 1` is a stack, and a manual price replaces the trade figure — in each the quote no
    longer describes the number on screen. Same guards as `medianValueEl`, and the median shares the
    headline's unit or the two cannot be compared at a glance.
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

## Settings

`loadSettings()` logs the file it resolved (`[settings] loaded <path>`) once per process. More than
one `settings.json` can exist on a machine — an unpackaged run and a packaged one resolve
`app.getPath("userData")` differently — so "the settings say X" is not a checkable claim without the
path beside it, and an afternoon went into discovering that the hard way.

`Settings` (`src/shared/settings.ts`) is loaded/saved via `src/main/settings.ts`, which copies
`config/settings.default.json` into `app.getPath("userData")/settings.json` on first run. On every
load, `mergeWithDefaults()` recursively fills in any key present in `config/settings.default.json`
but missing from the user's `settings.json` (and rewrites the file with the result), so an existing
install whose settings.json predates a schema change doesn't end up with `undefined` values at
runtime — it self-heals rather than needing a manual edit. When changing the `Settings` shape,
still update **both** `config/settings.default.json` and the type, so the merge has a default to
fall back to.

**Two keys ship blank or generic on purpose and must stay that way**, because the defaults file is
public and installed on other people's machines: `trade2.contactEmail` (`""` — it goes in the
`User-Agent` of every GGG request, so a real address here makes every user's traffic identify as
whoever committed it) and `league` (a plausible current league, since it's only ever a prefill the
user confirms). Don't commit a working value for either. `setupCompleted` defaults to `false`, which is what makes
the setup window appear once — including for installs upgrading past the key, since
`mergeWithDefaults` fills it in.

**Which keys the settings window may edit is a rule, not a list.** `SettingsConfig`
(`shared/types.ts`) is `hotkeys`, the editable part of `overlay`, `display.currency`, and four
`trade2` keys — `saleType`, `listingStatus`, `useMapFilters` and `mapMinRatio` — everything nothing
downstream captured, which is exactly what can be applied
without a relaunch. Adding a key there means checking that no client, closure or watcher read it at
construction; if one did, it belongs to the setup window and its restart instead. The four `trade2`
keys qualify on exactly that test and are worth reading as the worked example: `Trade2Client` holds
the same `Settings` object `index.ts` mutates and reads `this.settings.trade2.saleType` and
`.listingStatus` while building each query, and the two map keys while building a waystone's filters,
so a save reaches the very next lookup. Most of that block does **not** qualify — which is why
`onSettingsSaved` assigns those four **field by field** rather than replacing the `trade2` object.
`mapMinRatio` is stored as a ratio and edited as a percentage: `readNumber` rounds to whole numbers,
so a ratio typed directly would round 0.9 to 1 and silently mean "no widening at all".

**A changed default reaches new installs and nobody else**, which is what
`adoptInstantBuyoutDefault()` (`main/settings.ts`) exists for. `mergeWithDefaults` fills in *missing*
keys only, so when `trade2.listingStatus` moved from `"online"` to `"securable"` every existing
settings.json went on searching in-person listings — invisibly, since "View search" faithfully
reopens the same query and the trade site therefore agrees with the app. The fold rewrites an exact
`"online"` once and stamps `trade2.listingStatusMigrated`, so a deliberate `"online"` picked in the
settings window afterwards is never overridden. That marker is why the migration is safe to keep now
that the key has a dropdown; a fold that kept correcting the value would make that dropdown silently
not work. Only the old shipped default is touched — the other four options could only have been
typed by hand.

**`adoptListingThresholdDefault()` is the same fold for the same reason, and it is the one that
proves the rule.** `trade2.minListingsForMatch` shipped as **10** and moved to **1**; every install
predating that kept 10, so the ladder went on walking past the rung carrying an item's whole mod set
whenever fewer than ten listings had it. That surfaced as four separate "the trade site finds it and
the app doesn't" reports before anyone thought to check `git log` on the defaults file. It rewrites an
exact 10 once, stamps `trade2.minListingsThresholdMigrated`, and takes its target from the defaults
file rather than a second literal so the fold can't drift from what it exists to adopt.

**A default this shape needs a fold like this one, not just an edit to
`settings.default.json`.** Two have needed one now; assume the next will.
`loadDefaultSettings()` backs the per-field
Reset buttons, so "default" in the window means the same thing it means to `mergeWithDefaults`
rather than a second set of constants in the renderer.

## Known non-goals / do not "fix"

- No global hotkey for item capture (see ClipboardWatcher above) — this is deliberate, not missing.
- **The release check not downloading anything is the feature.** Don't "finish" it with
  `electron-updater`: the portable target can't self-update at all, the binaries are unsigned, and
  the workflow publishes no `latest.yml` — see the update-check notes above for the three changes
  that would each need making first. Notify-and-link covers both downloads identically.
- `UpdateChecker` not reusing `appUserAgent()` is not an oversight. That string carries the user's
  `trade2.contactEmail` because GGG's developer policy asks for a contact; GitHub is not GGG, and
  reusing it would hand a personal address to a service that never asked for one.
- `#update-status` being hidden in the panel's minimal form is deliberate, like the rest of that
  list: it isn't actionable while you're playing, and the tray entry is the copy that persists. It
  also keeps the only clickable thing in the header off screen while the panel is click-through.
- **One list, one window, one Clear.** There is no live feed, no History view and no per-map
  drill-down; all of that was removed on purpose, because the same drop showed up in
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
- The list spans **everything ever captured**, and grows without bound until the user presses Clear.
  That's the design, not a failure to clear.
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
- `ParsedItem.mods` duplicating `implicitMods`/`explicitMods` is deliberate — see the parser notes
  above. Don't "deduplicate" it by deleting the arrays; they are the persisted shape.
- `isKnownNonModLine` surviving alongside the header gate is not dead code. The gate only arms when
  the item printed headers, so without that list a capture made without **Advanced Item Descriptions**
  has nothing rejecting its usage-instruction lines. Don't delete an entry on the grounds that the
  gate already covers it — it covers it for one half of the player base.
- Nothing migrates `loot-cache.json`, so items captured **before** a parser fix keep whatever they
  were stored with; Reprice re-reads the stored `mods` rather than reparsing. A jewel picked up
  before the gate existed still shows its socket-instruction row until it is picked up again. Don't
  paper over that by filtering in `modsOf()` — that duplicates parser rules into `shared/` for a
  cosmetic gain on historical rows.
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
- `CurrencyExchangeClient` covering only currency-exchange-traded items, and therefore never pricing
  rares, is inherent to the data source. It is a fallback for poe.ninja, not a replacement for
  trade search.
- Partial coverage in `exchange-metadata-ids.ts` is deliberate: an unmapped name returns null and
  the item falls through to unpriced, whereas a wrong entry silently reports a different item's
  price. Omit ids you cannot verify.
- **There is no map detection, and adding it back is not a fix.** `Client.txt` tailing, zone
  classification, per-map sessions and the header's map total were all removed together, along with
  the Steam install detection that existed only to find that file. The zone heuristic
  (Hideout/Atlas = end, anything else = start) misfired on campaign and town zones, it forced a
  machine-specific path into first-run setup that nothing else needed, and the per-map slice was a
  second way of looking at a list that already spans everything. Don't reintroduce `sessionId`,
  a `sessions` array, or a running per-map total.
- The setup window saving via a **restart** rather than applying values live is deliberate, and so is
  it covering only two settings. Don't "unify" it with the settings window: the restart is the
  honest way to apply a league three clients captured at construction, and a single dialog would have
  to restart for every change or lie about which ones need it.
- The settings window covering **only** hotkeys, the overlay block, the display currency and the
  two `trade2` search filters is the same rule from the other side, not an unfinished job. Everything else in `settings.json` is a
  tuning knob with a working default that no UI has to exist for. The bar for adding a field is "can
  this be applied in place", not "is this configurable" — see the Settings section above.
- **Hotkeys are suspended while the settings window is open, and re-registered when it closes.** Not
  an oversight in the live-apply path: a bound accelerator is taken by the OS before any renderer
  sees it, so the recorder could not otherwise capture a combo that is already in use. Don't
  "improve" this by re-registering on save.
- A refused accelerator being **saved anyway** is deliberate. `globalShortcut.register` returning
  false means the combo is unavailable *right now*, usually because another app is running; refusing
  to store it would make the user's choice depend on what happened to be open at the time.
