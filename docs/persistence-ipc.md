# Persistence and the IPC surface

`src/db/store.ts`, `src/shared/ipc-channels.ts`, `src/main/ipc.ts` and `src/preload/index.ts`.

Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---

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
setup window in [main-process.md](main-process.md) for why they can't share a call. The settings window's two
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
