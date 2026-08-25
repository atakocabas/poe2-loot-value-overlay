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
npm run dev       # build, run, and restart the app on every change — the iterative loop
npm run build     # tsc compile (src -> dist) + copy renderer assets + draw the app icons
npm test          # npm run build && node --test dist/test/*.test.js  (506 tests, ~2s after the build)
npm run watch     # tsc --watch alone: type-checking with no rebuild or restart loop
npm start         # npm run build && electron .
npm run package   # npm run build && electron-builder --win --publish=never -> release/
```

There is no test filtering flag wired up. To run a single test file, build first, then invoke node's
test runner directly against the compiled output:

```bash
npm run build && node --test dist/test/store.test.js
```

Tests live in `src/test/*.test.ts` and run against compiled JS in `dist/test/`, using Node's
built-in `node:test` runner (not Jest/Vitest) — `describe`/`test`/`assert` from `node:test` and
`node:assert`.

**Renderer functions are testable despite exporting nothing**, which `item-groups.test.ts` is the
pattern for: it reads `dist/renderer/common.js`, runs it as a script in a `node:vm` context with a
stub `document`, and picks the function off the context's global — which is how the page itself gets
it. Use this rather than moving renderer logic into `shared/` to make it importable: the
plain-`<script>` constraint below is why it lives there, and a second copy in `shared/` would drift
from the one the panel actually runs.

`npm run dev` is hand-rolled and four things in it are load-bearing; packaging needs Developer Mode;
releases are cut by bumping the version rather than by merging. All three in
[docs/dev-loop.md](docs/dev-loop.md).

## Architecture

Standard Electron three-process split, but with no bundler for the renderer — the renderer loads
compiled JS as a plain `<script>` tag (see `src/renderer/index.html`), so **renderer code can only
use type-only imports from shared modules** (erased at compile time); it cannot `require()` or
import runtime values, since `contextIsolation` is on and `nodeIntegration` is off. Where a shared
helper is genuinely needed at runtime in both processes (e.g. `formatValue` in
`shared/format-value.ts`), it's duplicated as a small inline function in `src/renderer/common.ts`
rather than restructured to be importable — and `src/test/renderer-parity.test.ts` is what stops the
two copies drifting.

Data flow, item capture to UI:

1. **`ClipboardWatcher`** (`src/main/clipboard-watch.ts`) polls the clipboard every 150ms and fires
   when the text looks like an item. → [docs/main-process.md](docs/main-process.md)
2. **`parseItemText()`** (`src/parser/item-text-parser.ts`) turns that text into a `ParsedItem`.
   → [docs/parser.md](docs/parser.md)
3. **`PriceResolver`** (`src/pricing/price-resolver.ts`) tries poe.ninja, then the currency exchange,
   then trade2 search. → [docs/pricing-sources.md](docs/pricing-sources.md),
   [docs/pricing-trade2.md](docs/pricing-trade2.md)
4. **`PricingQueue`** (`src/pricing/queue.ts`) throttles, persists and pushes to the renderer.
   → [docs/pricing-sources.md](docs/pricing-sources.md)

`src/main/index.ts` is the composition root — everything is constructed and connected there at
`app.whenReady()`. Read it first to see how the pieces fit together.

## Read before you edit

The docs below are the record of *why* things that look like bugs are correct. They are not
background reading: most of what is in them was arrived at by measuring against live GGG data, and
several rules have been "fixed" back into regressions more than once.

| Editing | Read first | Because |
|---|---|---|
| `src/pricing/trade2-client.ts`, `trade-budget.ts`, `rate-limiter.ts`, `ggg-fetch.ts`, `trade-stats.ts`, and the `shared/` stat derivations, `item-category.ts` and `instilled-notables.ts` | [docs/pricing-trade2.md](docs/pricing-trade2.md) | The largest doc, and the one with the most measured-not-guessed rules: the removed count axis, the price floor's missing `option`, the strict-rung rule, the drop ladder, the pseudo aggregates, the class-not-base-type search, the notable split. Four repeat regressions came from changing these without reading it. |
| `src/renderer/*` | [docs/renderer.md](docs/renderer.md) | The panel's two forms, what `renderList()` must preserve by hand, and why pending captures live outside `allItems`. |
| `src/main/*` | [docs/main-process.md](docs/main-process.md) | Window rules (a second full-screen overlay swallows every click), hotkey suspension, overlay visibility, the tray, the icon, the release check. |
| `src/parser/item-text-parser.ts` | [docs/parser.md](docs/parser.md) | Advanced Item Descriptions changes the mod format substantially, and the header gate is authoritative rather than merely tolerated. |
| `src/pricing/price-resolver.ts`, `poeninja-client.ts`, `currency-exchange-client.ts`, `exchange-metadata-ids.ts`, `currency-convert.ts`, `queue.ts` | [docs/pricing-sources.md](docs/pricing-sources.md) | poe.ninja's restraint rules, the exchange's inverted ratios, and why metadata ids must be added by hand. |
| `src/db/store.ts`, `src/shared/ipc-channels.ts`, `src/main/ipc.ts`, `src/preload/index.ts` | [docs/persistence-ipc.md](docs/persistence-ipc.md) | What each channel carries, and which handlers must stay in step. |
| `src/shared/settings.ts`, `config/settings.default.json`, `src/main/settings.ts`, the two config windows | [docs/settings.md](docs/settings.md) — or run `/settings-key` | Three files move together, and a *changed* default needs a migration fold to reach existing installs. [docs/configuration.md](docs/configuration.md) is the user-facing table of the same keys, and moves with them. |
| `src/renderer/*.html\|css`, or anything the panel draws | [docs/images/](docs/images/) via `npm run screenshots` | The README's screenshots are committed PNGs of the real renderer (`scripts/screenshots.js`), so a UI change leaves them stale until they're redrawn. |
| `scripts/`, `package.json`, `.github/workflows/` | [docs/dev-loop.md](docs/dev-loop.md) | The dev loop's restart rules, and the release version gate. |

## Hard invariants

These are the ones violated within a single edit, before any doc gets opened. Everything else lives
in the docs above.

- **Renderer files are plain `<script>`s sharing one global scope.** `src/renderer/common.ts` and
  `src/renderer/index.ts` must contain no top-level `import`/`export` at all — even `import type`
  marks the file as an ES module and tsc emits `exports` boilerplate that throws. `setup.ts` and
  `settings.ts` are wrapped in IIFEs declaring no top-level names, because that global scope spans
  every renderer file. Shared types come from the `declare global` block in
  `src/renderer/global.d.ts`. Adding a page means adding it to `scripts/copy-assets.js` too.
- **Never register Ctrl+C as an Electron `globalShortcut` for capture.** That intercepts the combo
  system-wide, so PoE2 never receives it and never writes the item to the clipboard. This was a real
  bug; `ClipboardWatcher` polling is the design, and `forceCapture()` is the manual fallback.
- **No OAuth, no `clientId`, no `Authorization` header on trade2 calls.** Every GGG endpoint this app
  touches is public and unauthenticated. A Bearer token on an endpoint that takes none fails
  silently, which is exactly how this stayed broken once before.
- **GGG's trade2 rate limits are per IP, not per app.** Another trade tool, or a second copy of this
  app, spends the same budget. The defaults leave deliberate headroom — don't raise them to "use the
  full limit".
- **Read through the accessors, never the raw arrays:** `modsOf()` (`src/shared/mods.ts`),
  `defencesOf()` (`src/shared/defences.ts`), `weaponStatsOf()` (`src/shared/weapon-stats.ts`). Items
  persisted before those fields existed have only the older shape.
- **Nothing migrates `loot-cache.json`, and nothing should.** Unknown keys ride along unread; items
  keep whatever they were stored with. `settings.json` is the opposite case — see
  [docs/settings.md](docs/settings.md).
- **One list, one overlay window, one Clear.** No live feed, no History view, no per-map drill-down,
  no second overlay window — all removed on purpose. Grow the filters on the one list instead.
- **There is no map detection.** `Client.txt` tailing, zone classification, per-map sessions, the
  header's map total and the Steam install detection were removed together. Don't reintroduce
  `sessionId`, a `sessions` array, or a running per-map total.
- **Two settings keys must ship blank or generic**, because `config/settings.default.json` is public
  and installed on other people's machines: `trade2.contactEmail` (`""`) and `league`.
- **Changing a `Settings` key touches three files** — the type, `config/settings.default.json`, and
  the fixture in `src/test/settings.test.ts`. Run `/settings-key`.
- **Bump `package.json` and `package-lock.json` together** (`npm version <v> --no-git-tag-version`,
  and check its diff — it reformats the `build` block). That bump is what cuts a release.

## Non-goals / do not "fix"

The reasoned versions of these, and the thirty-odd others, sit in the doc for the thing they are
about. This is the short list of what an unbriefed change most often breaks:

- No global hotkey for item capture — deliberate, not missing.
- The release check notifying rather than downloading is the feature; `electron-updater` is not a
  small change here.
- Pending rows living outside `#item-list` *and* outside `allItems` is not a layout accident.
- The list spans everything ever captured and grows unbounded until the user presses Clear.
- The panel's form is the `toggleList` hotkey's business and nothing else's — it is never opened or
  closed for the user.
- `TradeSearchBudget` declining a lookup rather than waiting out the rate limit is deliberate, and so
  is the resulting "some rares in a big map go unpriced".
- Don't reintroduce count relaxation ("at least N of M") to widen a trade search.
- A rare is searched on its **item class** (`accessory.ring`), not its exact base type
  ("Prismatic Ring"). Reversing that back to base type is what left items on illiquid bases unpriced.
- An instilled notable resolves to its **enchant** stat id, never the identically-worded explicit
  one. Measured: 1167 listings against 0. The failure is silent — a dead filter takes the whole `and`
  group to zero and the row reads as though the item had no market.
- A Twisted/Distorted Amulet's two notables are never shed by the drop ladder, and when nobody lists
  the pair each is searched alone and the **dearer** market wins. That is the one place prices are
  compared across rungs rather than taking the strictest rung that matched.
- Magic items never go to trade2 — PoE2 glues the affixes onto the base type, so there is nothing
  reliable to search on. The class search makes a query mechanically possible; whether it's worth the
  per-IP budget is an open question needing measurement, not a loose end.
- Foreground-window detection shelling out to PowerShell is deliberate: every alternative is a native
  dependency, ruled out for the same reason `better-sqlite3` was.
