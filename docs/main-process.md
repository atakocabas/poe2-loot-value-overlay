# The main process: wiring, windows, watchers, tray and updates

`src/main/*` — the composition root, the three windows, the icon, the release check, the hotkeys and
overlay visibility, and the head of the capture data flow.

Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---

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
- **It uses plain `fetch`, not `createPublicGggFetch`.** Same argument as poe.ninja (see [pricing-sources.md](pricing-sources.md)) — GitHub is
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

Data flow, item capture to UI. **Step 1 is the only one that lives in this process**; steps 2
through 4 are in [parser.md](parser.md), [pricing-sources.md](pricing-sources.md) and
[pricing-trade2.md](pricing-trade2.md), and CLAUDE.md has the four-line overview.

1. `ClipboardWatcher` (`src/main/clipboard-watch.ts`) polls `clipboard.readText()` every 150ms and
   fires a callback when the text changes and looks like an item (`starts with "Rarity:"`).
   **It deliberately never registers Ctrl+C as an Electron `globalShortcut`** — `globalShortcut`
   intercepts a key combo system-wide via the OS, which would stop PoE2 (the focused window) from
   ever receiving the keystroke, so the game would never write the item text to the clipboard in
   the first place. This was a real bug once; don't reintroduce a hotkey-based capture path.
   `forceCapture()` is the manual fallback bound to a hotkey (`Ctrl+\``) — it always fires even if
   the clipboard is unchanged, unlike the automatic poll.

---

## Non-goals / do not "fix"

- No global hotkey for item capture (see ClipboardWatcher above) — this is deliberate, not missing.
- **The release check not downloading anything is the feature.** Don't "finish" it with
  `electron-updater`: the portable target can't self-update at all, the binaries are unsigned, and
  the workflow publishes no `latest.yml` — see the update-check notes above for the three changes
  that would each need making first. Notify-and-link covers both downloads identically.
- `UpdateChecker` not reusing `appUserAgent()` is not an oversight. That string carries the user's
  `trade2.contactEmail` because GGG's developer policy asks for a contact; GitHub is not GGG, and
  reusing it would hand a personal address to a service that never asked for one.

- Foreground-window detection shelling out to PowerShell instead of using `active-win` /
  `node-window-manager` / `koffi` — those are native deps, ruled out for the same reason
  `better-sqlite3` was (see [persistence-ipc.md](persistence-ipc.md)). Electron exposes no
  foreground-window API.

- **There is no map detection, and adding it back is not a fix.** `Client.txt` tailing, zone
  classification, per-map sessions and the header's map total were all removed together, along with
  the Steam install detection that existed only to find that file. The zone heuristic
  (Hideout/Atlas = end, anything else = start) misfired on campaign and town zones, it forced a
  machine-specific path into first-run setup that nothing else needed, and the per-map slice was a
  second way of looking at a list that already spans everything. Don't reintroduce `sessionId`,
  a `sessions` array, or a running per-map total.

- **Hotkeys are suspended while the settings window is open, and re-registered when it closes.** Not
  an oversight in the live-apply path: a bound accelerator is taken by the OS before any renderer
  sees it, so the recorder could not otherwise capture a combo that is already in use. Don't
  "improve" this by re-registering on save.
