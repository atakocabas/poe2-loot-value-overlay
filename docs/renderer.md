# The renderer: one page, one list, two forms

The overlay panel — `src/renderer/index.html`, `common.ts`, `index.ts` and `style.css`. Read before
changing anything the player sees while playing.

Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---

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

**The footer's Stop button is driven off that same pending list**, and it is the one footer button
that is ever urgent: a trade2 lookup can sit on a rate-limit lockout for half an hour, and every
capture taken afterwards queues behind it. `syncStopButton()` enables it whenever some pending entry
has a stage other than `queued` — an entry still waiting its turn has no request out and
`cancelCurrent()` would decline it, and a button that declines is worse than one visibly unavailable.
It is deliberately **not** gated on the 300ms grace period below: that delay exists so a fast lookup
never flashes a row, and a lookup slow enough to be worth stopping is long past it — matching the two
would leave the button dead for the first moments of every stall. The handler disables on the press
rather than on the answer and never re-enables itself; the `PRICING_STATUS` push that rides with the
cancelled item is what decides, since only it knows whether the queue is now idle or already on the
next item. "Nothing to stop" is a real outcome worth printing, because the lookup can finish between
the button lighting up and the press landing.

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

---

## Non-goals / do not "fix"

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
  on top, show no loot data, and are closed while you play (see those windows in
  [main-process.md](main-process.md)).
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
- **An unpriced row says *which* kind of unpriced it is, and there is one table deciding that.**
  `UNPRICED_REASON` in `common.ts` maps each `PricedItem.unpricedReason` to the badge word, the
  generic half of the tooltip, and whether it is recoverable; `unpricedLabel()` reads it and both
  `sourceBadge` and `renderItemRow`'s value cell go through that one function, so the badge and the
  number's slot can never disagree. The item's own `unpricedDetail` — the resolver's sentence,
  verbatim — is appended under the generic half. Three traps: the value cell keys on
  `total === null`, so it also guards on `priceSource === "unpriced"` (a group's total goes null
  when *any* member is unpriced); an unrecognised code falls back to the plain word rather than
  printing the raw identifier, which is what a downgrade produces; and the badge word **must not** be
  `not searched`, which the editor already uses on individual mod rows for an unrelated reason.
  `groupItems` folds on `unpricedReason` as well, since a group shows only its newest member's badge.
  See [pricing-trade2.md](pricing-trade2.md) for where the kinds come from.
- **Anything that ticks with the clock rewrites labels; it never calls `renderList()`.** Three do it
  now — `refreshElapsedLabels` (30s, capture times and listing ages) and `tickCooldown` (1s, the
  rate-limit countdown). Each finds its own elements by class, reads a timestamp off the element or a
  module global, and rewrites `textContent`. A wholesale rebuild on a timer would fight the user's
  scrolling and reset a half-filled row editor, since `renderList()` restores both by hand. Two rules
  that come with it: each label needs its **own** pass when its text has a prefix (`listed …`,
  `retry in …`) — the bare-rewrite loop strips the word — and any 1s timer must start and stop with
  the thing it is counting (`syncCooldownTimer`, mirroring the pending timer), because this window
  sits on top of a game.
- **The suggested sell price lives in the editor, and the row keeps one number.** `suggestSellRange()`
  in `common.ts` reads `tradeListingSample` and `tradeListingIndexedAt` and returns a verdict;
  `sellSuggestionText()` words it. The split is deliberate — the arithmetic is tested without a DOM,
  and the wording lives in one place, the same separation `unpricedLabel` has from the badge that
  prints it. Four things that come with it:
  - It takes the **guard set `listedAgeEl` uses** (`count !== 1`, `stackSize !== 1`, non-trade2,
    manual override, no listing date) and returns null for each, because a suggestion is an annotation
    on one listing's number and is a lie about a group total or a stack.
  - It is **re-run in place by `syncSuggestion`**, called from both the reprice and the manual-price
    handlers, for exactly the reason `syncTradeLink` is: `applyUpdatedItem` re-renders the list but
    the editor is *moved* rather than rebuilt, so an untouched node keeps describing the old listings.
  - It needs **no clock ticker**, unlike everything else on the panel that shows an age. It is only
    ever built while the editor is open, and `.item-value-listed` on the row already answers "how old
    is this" on the 30s pass.
  - `.item-edit-row[hidden]` in style.css is **load-bearing**, the same trap as the icon button below:
    without it the author `display: flex` beats the UA `[hidden] { display: none }` and hiding the row
    leaves an empty flex line in the editor.
- **The row's globe icon button is a shortcut to the editor's "View search" button, not a second
  implementation of it.** Both call `window.poe2Overlay.openTradeSearch(itemId)` — no new IPC
  channel. `viewSearchIconButton` hides itself when `item.tradeSearchId` is unset, same rule as the
  editor's `viewButton`, but it has no status line to report a stale/expired search into, so a
  `false` return flashes the tooltip text instead of writing into the row.
- **`button.icon-btn`'s CSS selector must keep `:not([hidden])`.** An author `display` rule wins
  over the UA stylesheet's `[hidden] { display: none }` at equal specificity, so a plain
  `button.icon-btn { display: inline-flex; ... }` silently un-hides the row's view-search icon for
  every item with no `tradeSearchId` — it renders and looks clickable, and clicking it does
  nothing you can see (a tooltip-text flash you'd have to be hovering to notice). This was a real
  bug, caught only by driving the built app's devtools live rather than reading the diff.
- **The panel's form is the hotkey's business and nothing else's.** It is never opened *or* closed
  for you: leaving a map doesn't expand it, and entering one doesn't collapse it. Both of those
  existed and were removed in turn — auto-expanding in the hideout first, then `collapsePanel()` on
  map entry. Don't reintroduce either; a panel that resizes itself while you play is the thing this
  arrived at.
- **`toggleList` flipping `overlayInteractive` too is the feature.** Expanding the list to press Edit
  is useless while the panel still passes clicks through, so the one key does both. It is now the
  **only** way into interactive mode: a `toggleOverlay` hotkey used to flip click-through without
  resizing anything, and was removed — in the minimal form there is nothing to click, so unlocking
  clicks on their own bought a state with no use for it.
- `groupItems` folding identical stackables across the whole list — so one row reads
  `Exalted Orb x214` — is what "one instance per item" means here. It deliberately refuses to fold
  anything with mods or a manual price, since those aren't interchangeable even when the names match.
  **A group carries its newest member**, which is load-bearing rather than arbitrary: `group.item` is
  what `minimalGroups()` sorts the heads-up form by, what `visibleGroups()` sorts by under sort=time,
  and what the row prints as "Ns ago". Keeping the first one seen meant a repeat pickup folded into a
  group still dated from the original drop, so re-picking up a currency you already had left the
  heads-up showing an *older* item as the last drop. `count` and `total` were right the whole time,
  which is what made it look like a pricing fault instead of a sorting one.
