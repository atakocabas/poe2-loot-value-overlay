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

**`updateItem`'s patch type is an allowlist, and adding a field means adding it there.** The
`Partial<Pick<PricedItem, …>>` in `store.ts` names every field a patch may carry; a field left off it
is dropped in silence, with no type error, because a spread of a conditional object skips
excess-property checking. That is not hypothetical — `tradeListingQuote` was being passed and
persisted before it was listed, and the type simply didn't say so. `tradeListingSample` is the newest
entry; anything that writes through this handler needs one.

**IPC surface** (`src/shared/ipc-channels.ts`, `src/main/ipc.ts`, `src/preload/index.ts`): pushes
(`PRICED_ITEM`, `PRICING_STATUS`, `OVERLAY_STATUS`) go main -> renderer as items resolve; pulls
(`GET_STATUS`, `GET_ALL_ITEMS`, `CLEAR_HISTORY`, `GET_EDITOR_ROWS`, `REPRICE_ITEM`,
`SET_MANUAL_PRICE`, `REFRESH_PRICES`, `CANCEL_PRICING`, `CANCEL_REPRICE`, `COLLAPSE_PANEL`) are
renderer-invoked `ipcMain.handle` calls.
`CANCEL_PRICING` abandons the price lookup in flight and answers whether there was one to abandon —
not whether the press "worked", since an idle queue has nothing to stop and the button says so. It
returns as soon as the abort is sent rather than awaiting the outcome: the cancelled capture arrives
on `PRICED_ITEM` by the ordinary route a moment later, and waiting for it would hold the button
through the very stall it exists to end. It needs no companion push for the same reason. This is why
`registerIpcHandlers` takes the whole `PricingQueue` and why the composition root builds the queue
**before** it registers the handlers.

`CANCEL_REPRICE` does the same job for the row editor's Reprice, and is **a separate channel on
purpose**: the two address different work. `CANCEL_PRICING` names the pricing queue's current entry,
and a reprice never enters that queue — it raises no pending row, which is why the footer's Stop
answers "Nothing to stop" while one is plainly running. One channel doing both would abort whichever
happened to be in flight, which is the opposite of what a button sitting beside the search it started
should mean. The controller lives in `ipc.ts` as a module-level `repriceAbort`, cleared in a `finally`
guarded by identity — the same rule `ggg-fetch.ts` applies to `inFlight`, and for the same reason: a
reprice that started while this one was unwinding owns the handle now. One controller and not a map,
because the editor opens over one row at a time.
A cancelled reprice comes back with `cancelled: true` rather than as an error, and **touches no price
or reason field** — not even to clear them. The edited filters are still written, by the rule below;
the price, badge and detail are left exactly as they were, because a cancel disproved nothing.
This is the one place that differs from the queue's convention, where `unpricedReason: "cancelled"`
is right: there the item had no price to protect, and here writing it would label a price the row is
still displaying as stopped.

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
setup window in [main-process.md](main-process.md) for why they can't share a call. The settings window's three
(`GET_SETTINGS_CONFIG`, `SAVE_SETTINGS_CONFIG`, `SET_HOTKEY_CAPTURE`) come from
`registerSettingsIpcHandlers()` in `src/main/settings-window.ts`. All five ride the **same preload**, which exposes them as
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
holds it is closed. An empty accelerator is valid everywhere and means **disabled**. The probe is
only honest with nothing of ours registered, so the handler calls `unregisterAllHotkeys()` itself
immediately before the loop rather than assuming they are already down, and `onSettingsSaved` puts
the just-saved bindings back before the window closes.

`SET_HOTKEY_CAPTURE` is the settings page saying a key recorder is armed (`true`) or disarmed
(`false`), and main drops every binding for exactly that long. It exists because `globalShortcut`
takes a combo from the OS before any renderer sees it — the same mechanism that rules out Ctrl+C as
a capture hotkey — so the accelerator a user most wants to rebind is the one the recorder could
never see them press. It is a **push, not a lock**: `index.ts` keeps the flag in `hotkeyCaptureActive`
and `applyHotkeys()` consults it, so no ordering of these messages can leave the hotkeys down, and
the settings window's `closed` handler clears the flag for a window shut mid-record.

`GET_ALL_ITEMS` returns every item, unfiltered — the panel does its own grouping, sorting and
filtering client-side.

`COLLAPSE_PANEL` is the panel saying a click landed outside it, so the full list closes when you
click away. It takes nothing and answers nothing, and that is the point: `panelExpanded` and
`overlayInteractive` live in `main/index.ts` because `toggleList` is a global shortcut whose
keypress only ever reaches that process, so the page **reports** the click rather than deciding
anything. The collapse comes back on `OVERLAY_STATUS` exactly as the hotkey's does, which is what
keeps the two routes from drifting. The blur half of the same behaviour needs no channel at all —
it is a `blur` on the overlay window, and main already has that.

`OVERLAY_STATUS` carries the panel-wide state that isn't per-item — poe.ninja conversion rates, how
old the prices are, whether the overlay currently accepts clicks, which of the panel's two forms it
is in, and the panel's size — so the renderer never has to infer any of it. `GET_STATUS` is the
matching pull for initial load.
