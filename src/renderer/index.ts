// The overlay panel. **Read docs/renderer.md before changing what the player sees while playing** —
// the panel's two forms, what renderList() has to preserve by hand across a wholesale rebuild, and
// why pending captures live outside `allItems`.
//
// Loads as a plain <script> after common.js (no bundler, contextIsolation on, no
// nodeIntegration), so it can't have ANY top-level import/export statement — even a type-only
// `import type` marks the file as an ES module to tsc, which then emits `exports` boilerplate that
// throws in a non-module <script> context. PricedItem/Session come from the `declare global` block
// in global.d.ts (a .d.ts never gets separate JS emission, so its own import there is harmless), and
// the value/format/row helpers are globals from common.ts.
//
// There is exactly **one** list here, holding every item ever recorded. It replaced a two-row live
// feed, a History browser of per-map drill-downs, and a second always-on-top window that showed the
// current map — three renderings of one dataset, where an item could appear in all three at once.

const panel = document.getElementById("panel")!;
const priceStatusEl = document.getElementById("price-status")!;
const rateStatusEl = document.getElementById("rate-status")!;
const cooldownStatusEl = document.getElementById("cooldown-status")!;
const updateStatusEl = document.getElementById("update-status") as HTMLButtonElement;
const itemListEl = document.getElementById("item-list")!;
const pendingListEl = document.getElementById("pending-list")!;
const listEmptyEl = document.getElementById("list-empty")!;
const searchEl = document.getElementById("list-search") as HTMLInputElement;
const sortEl = document.getElementById("list-sort") as HTMLSelectElement;
const unpricedEl = document.getElementById("list-unpriced") as HTMLInputElement;
const refreshButton = document.getElementById("refresh-prices") as HTMLButtonElement;
const exportButton = document.getElementById("export-csv") as HTMLButtonElement;
const clearButton = document.getElementById("clear-history") as HTMLButtonElement;

/** Every recorded item, in capture order. Reloaded from the store only on load and after a clear. */
let allItems: PricedItem[] = [];
let pricesFetchedAt: number | null = null;
/** A GitHub release newer than the running build, pushed on OVERLAY_STATUS. Null means neither
 * the check has answered nor there is anything to say — the line is hidden either way. */
let availableUpdate: OverlayStatus["update"] = null;

/** Client-side view state over `allItems`, read off the static controls in index.html. */
let searchText = "";
let unpricedOnly = false;
let sortMode: "value" | "time" | "name" = "time";
/**
 * The open row editor, if any — kept as a live DOM node rather than a flag, and re-appended by
 * `renderItemRow` instead of rebuilt. The list re-renders wholesale on every pickup, and a fresh
 * editor each time would reset the mod checkboxes the user was in the middle of unticking and wipe
 * the reprice status line they were reading.
 */
let openEditor: { itemId: string; el: HTMLElement } | null = null;
/** The item whose editor is mid-open, while its pseudo stats are being fetched. */
let editorOpening: string | null = null;

/**
 * Captures with no price yet, replaced wholesale on each PRICING_STATUS push.
 *
 * Kept out of `allItems` entirely rather than mixed in as placeholder rows. Four things assume
 * everything in that array is a real stored item: `groupItems` keys stackables on
 * `name|priceSource`, so a pending row would form its own group and then migrate on completion —
 * reading as a row vanishing while another's count jumps; `renderList` restores `scrollTop` around a
 * wholesale rebuild; the CSV export writes the lot; and `priceSource` is a closed union the store
 * persists.
 */
let pendingCaptures: PendingCapture[] = [];
let pendingTimer: ReturnType<typeof setInterval> | null = null;
/** How many pending rows are actually drawn — fewer than `pendingCaptures` during the grace period. */
let pendingVisible = 0;

// ---------------------------------------------------------------------------
// Header status
// ---------------------------------------------------------------------------

/**
 * Prices come from a cache refreshed on an interval, so a value can be up to 10 minutes stale — and
 * if poe.ninja is unreachable it can be arbitrarily stale without anything else changing on screen.
 */
function renderPriceStatus(): void {
  if (pricesFetchedAt === null) {
    priceStatusEl.textContent = "Prices: waiting for poe.ninja…";
    priceStatusEl.classList.add("stale");
    return;
  }
  const minutes = Math.floor((Date.now() - pricesFetchedAt) / 60000);
  priceStatusEl.textContent = minutes < 1 ? "Prices: just updated" : `Prices: ${minutes}m old`;
  priceStatusEl.classList.toggle("stale", minutes >= 30);
}

/**
 * The rates every value on the panel was converted with — worth showing outright, since otherwise
 * the only way to learn what a divine currently goes for is to alt-tab to poe.ninja. Freshness is
 * already stated by the price-age line directly above; this is the same data's timestamp.
 */
function renderRateStatus(): void {
  const line = formatHubRates(rates);
  rateStatusEl.textContent = line ?? "";
  rateStatusEl.classList.toggle("hidden", line === null);
}

/**
 * How long until trade2 lookups resume. Hidden whenever there is nothing to wait for, which is most
 * of the time — the budget is only ever spent by a burst of rares.
 *
 * The header half of the countdown; `.item-value-cooldown` on the rows is the other. Both are wanted:
 * this one is visible even when no rate-limited row is scrolled into view, while the rows carry it
 * into the minimal panel, where the whole header is hidden.
 */
function renderCooldownStatus(): void {
  const remaining = cooldownRemainingMs();
  cooldownStatusEl.textContent =
    remaining > 0 ? `Trade searches: ready in ${formatCountdown(remaining)}` : "";
  cooldownStatusEl.classList.toggle("hidden", remaining === 0);
}

/**
 * A newer release, or nothing. Hidden in both the "no update" and the "haven't checked yet" cases —
 * they look identical from here, and neither has anything to say.
 *
 * The URL never reaches this page: `openReleasesPage()` takes no argument, and the main process
 * opens the link it already holds.
 */
function renderUpdateStatus(): void {
  updateStatusEl.textContent = availableUpdate
    ? `Update available: v${availableUpdate.version} — get it`
    : "";
  updateStatusEl.classList.toggle("hidden", availableUpdate === null);
}

updateStatusEl.addEventListener("click", () => {
  void window.poe2Overlay.openReleasesPage();
});

/**
 * Whether the panel is in its minimal, heads-up form. **This is the resting state**, which is why it
 * starts true and why `#panel` ships with the class in index.html.
 *
 * Driven by `OverlayStatus.expanded` — the `toggleList` hotkey — and by nothing else.
 */
let minimalMode = true;

/**
 * Switches the panel between its two forms: the heads-up display it rests in, and the full panel —
 * filters, the whole list, Export/Clear, per-row Edit — that the `toggleList` hotkey opens.
 * `MINIMAL_ROWS` and the `#panel.minimal` block in style.css are the two halves of that.
 *
 * No grace and no re-check: this only ever runs because the user pressed a key, and a keypress
 * should land immediately.
 */
function setMinimalMode(minimal: boolean): void {
  if (minimal === minimalMode) return;
  minimalMode = minimal;

  // Collapsing slices the editor's row away, so the node would be orphaned — and re-appearing on the
  // next expand, mid-edit, is worse than closing. The user pressed the key that did this.
  if (minimal) openEditor = null;

  panel.classList.toggle("minimal", minimal);
  // The row count changes with the mode, so the list has to rebuild.
  scheduleRender();
}

function applyStatus(status: OverlayStatus): void {
  rates = status.rates;
  displayCurrency = status.displayCurrency;
  pricesFetchedAt = status.pricesFetchedAt;
  tradeCooldownUntil = status.tradeCooldownUntil;
  availableUpdate = status.update;
  panel.classList.toggle("interactive", status.interactive);
  setMinimalMode(!status.expanded);
  panel.style.width = `${status.panel.width}px`;
  panel.style.maxHeight = `${status.panel.maxHeightPercent}vh`;
  // A class rather than an inline style, unlike the two above: the side carries no number of its
  // own, and the offset from the edge is the same 24px either way.
  panel.classList.toggle("left", status.panel.position === "left");
  renderPriceStatus();
  renderRateStatus();
  renderCooldownStatus();
  renderUpdateStatus();
  // A push can start a cooldown (a lookup just spent the last slot) or end one, so the ticker is
  // re-evaluated here rather than only when a row is drawn.
  syncCooldownTimer();
  // Every value on screen was formatted with the old rates.
  scheduleRender();
}

/** Both the price age and the rows' "Ns ago" labels drift purely with the clock, not with events. */
function refreshElapsedLabels(): void {
  renderPriceStatus();
  // forEach rather than for..of: the tsconfig lib doesn't include DOM.Iterable.
  itemListEl.querySelectorAll<HTMLElement>(".feed-time").forEach((el) => {
    const at = Number(el.dataset.at);
    if (Number.isFinite(at)) el.textContent = relativeTime(at);
  });
  // Kept as its own pass rather than folded into the selector above: the listing age carries a
  // "listed" prefix that tells it apart from the capture time on the line below, and the bare
  // rewrite that loop does would strip the word every tick.
  itemListEl.querySelectorAll<HTMLElement>(".item-value-listed").forEach((el) => {
    const at = Number(el.dataset.at);
    if (Number.isFinite(at)) el.textContent = `(listed ${relativeTime(at)})`;
  });
}

window.poe2Overlay.onOverlayStatus(applyStatus);
setInterval(refreshElapsedLabels, 30000);

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

window.poe2Overlay.onPricedItem((item) => {
  allItems.push(item);
  scheduleRender();
});

// ---------------------------------------------------------------------------
// Pending captures
// ---------------------------------------------------------------------------

/**
 * How long an item must go unpriced before its row is drawn.
 *
 * poe.ninja and the currency exchange are synchronous cache lookups, so most drops are priced within
 * a microsecond of being captured. Without a grace period every one of them would strobe a
 * placeholder for a single frame; with it, only the items that are genuinely slow ever appear.
 */
const PENDING_GRACE_MS = 300;

/**
 * How often a visible pending row is redrawn, to advance its elapsed count and to let a row that has
 * just outlived the grace period appear. Runs only while something is pending, so an idle app has no
 * timer at all.
 *
 * `setInterval` and not `requestAnimationFrame`, for the reason given on `scheduleRender`: this
 * window is hidden whenever PoE2 isn't in front, and a hidden window never paints.
 */
const PENDING_TICK_MS = 250;

/**
 * How often the rate-limit countdown advances. Once a second, because it is displayed to the second.
 *
 * Runs only while a cooldown is actually running, like the pending timer above — this window sits on
 * top of a game, and an idle overlay should not burn a wakeup every second forever. `setInterval` for
 * the same reason as that one: a hidden window never paints, so rAF would stall while PoE2 is in
 * front, which is exactly when the countdown matters.
 */
const COOLDOWN_TICK_MS = 1000;

let cooldownTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Advances every countdown on screen, in place.
 *
 * **Deliberately not `scheduleRender()`.** That rebuilds the list wholesale and has to restore
 * `scrollTop` and the open editor by hand; doing it once a second would fight the user's scrolling
 * and their half-ticked mod boxes. Same approach as `refreshElapsedLabels` — find the labels, rewrite
 * their text, touch nothing else.
 */
function tickCooldown(): void {
  renderCooldownStatus();
  // Read once, so every row on screen reports the same second even if the tick straddles one.
  const remaining = cooldownRemainingMs();
  const text = remaining > 0 ? `retry in ${formatCountdown(remaining)}` : "ready to reprice";
  itemListEl.querySelectorAll<HTMLElement>(".item-value-cooldown").forEach((el) => {
    el.textContent = text;
  });
  // Stops the ticker on the tick that reaches zero, leaving "ready to reprice" on screen.
  syncCooldownTimer();
}

/** Starts the ticker while a cooldown is running and stops it once one isn't. */
function syncCooldownTimer(): void {
  const running = cooldownRemainingMs() > 0;
  if (running && cooldownTimer === null) {
    cooldownTimer = setInterval(tickCooldown, COOLDOWN_TICK_MS);
  } else if (!running && cooldownTimer !== null) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

window.poe2Overlay.onPricingStatus((pending) => {
  pendingCaptures = pending;
  renderPending();

  if (pendingCaptures.length > 0 && pendingTimer === null) {
    pendingTimer = setInterval(renderPending, PENDING_TICK_MS);
  } else if (pendingCaptures.length === 0 && pendingTimer !== null) {
    clearInterval(pendingTimer);
    pendingTimer = null;
  }
});

function pendingStateLabel(pending: PendingCapture): string {
  if (pending.stage === "queued") return "Queued";

  // Counted from the capture rather than from the stage change: what the user is waiting on is the
  // time since they pressed Ctrl+C, and most of it is spent in the trade search's own rate-limit
  // spacing, which reports nothing at all while it sleeps.
  const seconds = Math.floor((Date.now() - pending.item.capturedAt) / 1000);
  const elapsed = seconds >= 1 ? ` ${seconds}s` : "";
  return pending.stage === "trade2" ? `Searching trade2…${elapsed}` : `Pricing…${elapsed}`;
}

function renderPendingRow(pending: PendingCapture): HTMLElement {
  const row = document.createElement("div");
  row.className = "item-row pending-row";

  const top = document.createElement("div");
  top.className = "item-row-top";

  const state = document.createElement("span");
  state.className = "pending-state";
  state.textContent = pendingStateLabel(pending);

  top.append(itemNameEl(pending.item), state);
  row.append(top);

  const sub = itemSubtitle(pending.item);
  if (sub) {
    const meta = document.createElement("div");
    meta.className = "item-row-meta";
    meta.append(sub);
    row.append(meta);
  }

  // Free, since the pending row already carries the whole parsed item — and this is exactly when
  // you want to check what it is you're waiting on.
  attachTooltip(top, pending.item);
  return row;
}

function renderPending(): void {
  const now = Date.now();
  const visible = pendingCaptures.filter((p) => now - p.item.capturedAt >= PENDING_GRACE_MS);

  pendingListEl.replaceChildren(...visible.map(renderPendingRow));
  pendingListEl.classList.toggle("hidden", visible.length === 0);
  pendingVisible = visible.length;
  syncEmptyNote();
}

let renderQueued = false;

/**
 * Coalesces the re-renders triggered within one task into a single rebuild. The list is rebuilt
 * wholesale rather than patched, and one capture can produce a PRICED_ITEM, a PRICING_STATUS and a
 * status push; with an unbounded list that is a full rebuild each, for one visible change.
 *
 * Deliberately `queueMicrotask` and **not** `requestAnimationFrame`: this window is created hidden
 * and stays hidden whenever PoE2 isn't in front, and a hidden window never paints, so rAF callbacks
 * don't run. The initial load renders into a hidden window every single time — with rAF the list
 * sat empty until the first paint, which is exactly what this was measured doing.
 */
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    renderList();
  });
}

function visibleGroups(): ItemGroup[] {
  const needle = searchText.trim().toLowerCase();
  // groupItems folds interchangeable stackables into one row — this is what keeps a season's worth
  // of Exalted Orbs a single line rather than one per pickup.
  let groups = groupItems(allItems);

  if (needle) {
    groups = groups.filter(
      (g) =>
        g.item.name.toLowerCase().includes(needle) || g.item.baseType.toLowerCase().includes(needle)
    );
  }
  if (unpricedOnly) groups = groups.filter((g) => g.total === null);

  groups.sort((a, b) => {
    if (sortMode === "name") return a.item.name.localeCompare(b.item.name);
    if (sortMode === "time") return b.item.capturedAt - a.item.capturedAt;
    return byValueDesc(a, b);
  });

  return groups;
}

/** How many drops the heads-up form shows. One: the point is confirming the last pickup. */
const MINIMAL_ROWS = 1;

/**
 * The newest drops, ignoring the filters entirely.
 *
 * **Deliberately not `visibleGroups()`.** `searchText`, `unpricedOnly` and `sortMode` persist while
 * their controls are hidden in this form, so a search left over from the last time the list was open
 * would silently filter the one row away with nothing on screen to explain why. The heads-up form
 * always means "the newest drop"; the filter state is untouched and comes back with the full panel.
 */
function minimalGroups(): ItemGroup[] {
  return groupItems(allItems)
    .sort((a, b) => b.item.capturedAt - a.item.capturedAt)
    .slice(0, MINIMAL_ROWS);
}

function renderList(): void {
  // replaceChildren resets scrollTop to 0. Without this a pickup arriving while the user is reading
  // something further down yanks them back to the top of a list that never stops growing.
  const scrollTop = itemListEl.scrollTop;

  const groups = minimalMode ? minimalGroups() : visibleGroups();
  itemListEl.replaceChildren(...groups.map((group) => renderItemRow(group)));
  itemListEl.scrollTop = scrollTop;

  syncEmptyNote();
}

/**
 * Shared by both lists, because the note sits below them both. A first capture still being priced
 * would otherwise read "No drops captured yet" directly underneath a row proving otherwise — and
 * driving it from `renderList` alone would mean rebuilding the whole item list on every pending
 * tick just to hide one line.
 */
function syncEmptyNote(): void {
  // A pending row only silences "nothing captured yet", which it plainly contradicts. Pending rows
  // are never filtered, so they say nothing about whether the *filter* matched — leaving that
  // message up is correct even while one is on screen.
  const contradicted = allItems.length === 0 && pendingVisible > 0;
  listEmptyEl.classList.toggle("hidden", itemListEl.childElementCount > 0 || contradicted);
  listEmptyEl.textContent =
    allItems.length === 0
      ? "No drops captured yet — Ctrl+C an item in game."
      : "Nothing matches this filter.";
}

// A row-level shortcut to the editor's "View search" button, so viewing the trade search a price
// came from doesn't require opening Edit first. Reuses the same IPC call and hidden-when-absent
// rule as `renderItemEditor`'s `viewButton` below — this one just has no status line to report a
// stale search into, so it flashes the tooltip text instead.
function viewSearchIconButton(item: PricedItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  const defaultTitle = "View search";
  button.title = defaultTitle;
  button.setAttribute("aria-label", defaultTitle);
  button.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="2.8" ry="6.5"/>' +
    '<path d="M1.7 8h12.6M2.6 4.8h10.8M2.6 11.2h10.8"/></svg>';
  button.hidden = !item.tradeSearchId;
  button.addEventListener("click", async () => {
    if (!(await window.poe2Overlay.openTradeSearch(item.id))) {
      button.title = "That search is no longer on file.";
      setTimeout(() => {
        button.title = defaultTitle;
      }, 2000);
    }
  });
  return button;
}

function renderItemRow({ item, count, total }: ItemGroup): HTMLElement {
  const row = document.createElement("div");
  row.className = "item-row";

  const top = document.createElement("div");
  top.className = "item-row-top";

  const value = document.createElement("span");
  // The reason goes where the number would go, not just on the badge: this is the half that is
  // visible in the minimal panel, where a row reading "unpriced" mid-map is the difference between
  // binning a rare and repricing it. Guarded on `priceSource` as well as `total`, since a null total
  // can arrive from a group whose members weren't all unpriced.
  const unpriced = total === null && item.priceSource === "unpriced";
  const reason = unpriced ? unpricedLabel(item) : null;
  value.className = total === null ? "item-value unpriced" : "item-value";
  if (reason?.recoverable) value.classList.add("recoverable");
  // Marked so `tickCooldown` can rewrite this one cell every second without re-rendering the list.
  // Only the rate-limited rows carry something that changes on its own.
  if (unpriced && item.unpricedReason === "rateLimited") value.classList.add("item-value-cooldown");
  // The cheapest listing's own currency when there is one, so a row priced off a seller asking
  // 2 chaos reads "2c" rather than the same value restated as 66ex. See `rowQuote`.
  value.textContent = unpriced
    ? unpricedValueText(item)
    : total === null
      ? "unpriced"
      : formatValue(total, rowQuote(item, count));

  // Offered for every item, not just unpriced ones: a price that resolved to the wrong unique
  // variant or a stale poe.ninja figure needs correcting just as much as a missing one does.
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = "Edit";
  toggle.addEventListener("click", async () => {
    if (openEditor?.itemId === item.id) {
      openEditor = null;
      scheduleRender();
      return;
    }
    // The aggregate rows are derived in the main process, so opening the editor is one round trip
    // now. `editorOpening` swallows a second click landing while the first is still in flight —
    // without it an impatient double-click builds two editors and the last one wins silently.
    if (editorOpening === item.id) return;
    editorOpening = item.id;
    const rows = await window.poe2Overlay.getEditorRows(item.id);
    editorOpening = null;

    openEditor = { itemId: item.id, el: renderItemEditor(item, rows) };
    scheduleRender();
  });

  top.append(itemNameEl(item, count), value);
  const listedAge = listedAgeEl(item, count, total);
  if (listedAge) top.append(listedAge);
  top.append(viewSearchIconButton(item));
  top.append(toggle);
  row.append(top);

  const meta = document.createElement("div");
  meta.className = "item-row-meta";
  const sub = itemSubtitle(item);
  if (sub) meta.append(sub);
  meta.append(sourceBadge(item));
  const time = document.createElement("span");
  time.className = "feed-time";
  // Read back by refreshElapsedLabels — the label drifts with the clock, not with any event.
  time.dataset.at = String(item.capturedAt);
  time.textContent = relativeTime(item.capturedAt);
  meta.append(time);
  row.append(meta);

  // append() *moves* the existing node, which is the point — it keeps its state across the render.
  if (openEditor?.itemId === item.id) row.append(openEditor.el);

  attachTooltip(top, item);
  return row;
}

/**
 * Folds an item the main process just updated back into the list, rather than re-fetching all of
 * them. Both editor actions return the stored item, so there is nothing left to ask the store for.
 */
function applyUpdatedItem(updated: PricedItem | null): void {
  if (updated) allItems = allItems.map((existing) => (existing.id === updated.id ? updated : existing));
  scheduleRender();
}

/** One mod's controls in the row editor, kept so Reprice can read them all back at click time. */
interface ModRow {
  el: HTMLElement;
  text: string;
  include: HTMLInputElement;
  /** null for a mod with no number in it — those are searched by presence and take no bound. */
  min: HTMLInputElement | null;
  max: HTMLInputElement | null;
}

/** An empty box means "no bound", which is a real choice: it searches the stat by presence alone. */
function boundValue(input: HTMLInputElement): number | null {
  const raw = input.value.trim();
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

const sumAmounts = (contributors: PseudoStat["contributors"]): number =>
  contributors.reduce((sum, contributor) => sum + contributor.amount, 0);

const isModUnticked = (rows: ModRow[], text: string): boolean =>
  rows.some((row) => row.text === text && !row.include.checked);

/**
 * One derived aggregate — "83% total Elemental Resistance" over the three rolls that make it up.
 *
 * Keyed by pseudo stat id rather than by text, which is what its bounds persist under and what
 * unticking it writes into `ignoredMods`; the two can't collide.
 */
/**
 * A row for something the search asks for that isn't a mod line — a derived aggregate or a waystone's
 * reward total. Both are keyed by a filter id rather than by text, both carry a floor derived from a
 * ratio, and both take bounds the user can override, so they share everything but their wording.
 *
 * The floor is a **placeholder**, not a value: it shows what the search will use while still reading
 * as "not set by hand", which is what lets an untouched row be left out of the request entirely.
 */
/**
 * The affix tiers behind a derived row, as `T1 T3` badges appended to its tag line.
 *
 * Shared with `renderModRow`'s single badge rather than duplicated: the class, the wording and the
 * "1 is the best" explanation all have to read identically, since the two badges sit inches apart on
 * the same list and mean exactly the same thing. Tiers the game didn't print are skipped — an item
 * captured without Advanced Item Descriptions has none at all, which is the ordinary case.
 */
function appendTierBadges(tags: HTMLElement, tiers: Array<number | null | undefined>): void {
  for (const tier of tiers) {
    if (typeof tier !== "number") continue;
    const badge = document.createElement("span");
    badge.className = "badge badge-tier";
    badge.textContent = `T${tier}`;
    badge.title = `One of the affixes summed into this total is tier ${tier} — 1 is the best possible roll.`;
    tags.append(badge);
  }
}

function renderDerivedRow(options: {
  id: string;
  label: string;
  total: number;
  minRatio: number;
  badge: string;
  badgeTitle: string;
  includeTitle: string;
  stored: ModFilter | undefined;
  rowClass: string;
  /** The contributing affixes' tiers, in contributor order. Omitted on rows that have no affixes. */
  tiers?: Array<number | null | undefined>;
}): ModRow {
  const el = document.createElement("li");
  el.className = options.rowClass;

  const include = document.createElement("input");
  include.type = "checkbox";
  include.checked = true;
  include.title = options.includeTitle;

  const body = document.createElement("div");
  body.className = "mod-body";

  const text = document.createElement("span");
  text.className = "mod-text";
  const roll = document.createElement("strong");
  roll.className = "mod-roll";
  roll.textContent = String(options.total);
  text.append(roll, ` ${options.label}`);

  const badge = document.createElement("span");
  badge.className = `badge badge-kind badge-kind-${options.badge}`;
  badge.textContent = options.badge;
  badge.title = options.badgeTitle;

  const tags = document.createElement("div");
  tags.className = "mod-tags";
  tags.append(badge);
  // One tier badge per contributing affix, in the same class and wording a mod row uses, so an 83%
  // total reads as "one T1 and two fillers" rather than as a bare number. `syncFolding` rebuilds
  // these from the ticked contributors, for the same reason it rewrites the total.
  appendTierBadges(tags, options.tiers ?? []);
  body.append(text, tags);

  const bounds = document.createElement("div");
  bounds.className = "mod-bounds";
  const min = boundInput("min", options.stored ? options.stored.min : null);
  min.placeholder = String(Math.floor(options.total * options.minRatio));
  const max = boundInput("MAX", options.stored ? options.stored.max : null);
  bounds.append(min, max);

  el.append(include, body, bounds);
  return { el, text: options.id, include, min, max };
}

/**
 * One derived aggregate — "83% total Elemental Resistance" over the three rolls that make it up.
 *
 * Keyed by pseudo stat id rather than by text, which is what its bounds persist under and what
 * unticking it writes into `ignoredMods`; the two can't collide.
 */
function renderPseudoRow(item: PricedItem, stat: PseudoStat, minRatio: number): ModRow {
  const row = renderDerivedRow({
    id: stat.id,
    label: stat.label,
    total: sumAmounts(stat.contributors),
    minRatio,
    badge: "pseudo",
    badgeTitle: `Summed from ${stat.contributors.length} mods, which are searched as this total instead of individually.`,
    includeTitle: "Untick to search these mods individually instead of as a total.",
    stored: item.pseudoFilters?.find((filter) => filter.text === stat.id),
    rowClass: "mod-pseudo",
    tiers: stat.contributors.map((contributor) => contributor.tier)
  });
  // Same rule as a mod row. An aggregate the search had to drop to find any market did not constrain
  // the price, so it opens unticked. Gated on a search record existing, or an item that never ran one
  // would untick on the strength of a `pseudoDropped` no search ever set.
  row.include.checked =
    !item.ignoredMods.includes(stat.id) &&
    !(item.searchedMods !== undefined && item.pseudoDropped === true);
  return row;
}

/**
 * One of a waystone's printed totals — what it is actually traded on.
 *
 * No checkbox behaviour to speak of: unlike an aggregate there is nothing to fall back to, since the
 * affixes that produced this number are never searched. It stays ticked and disabled.
 */
function renderMapRow(item: PricedItem, mapRow: MapRow, minRatio: number): ModRow {
  const ceiling = mapRow.direction === "max";
  const row = renderDerivedRow({
    id: mapRow.id,
    label: mapRow.label,
    total: mapRow.value,
    minRatio,
    // Difficulty is not a reward, and badging it as one is the misreading this row exists to correct.
    badge: ceiling ? "difficulty" : "reward",
    badgeTitle: ceiling
      ? "How much harder this waystone's monsters are. A cost to the buyer, not a benefit, so it's " +
        "searched as a ceiling — the comparables are the waystones at most this dangerous."
      : "A total the game prints on the waystone, produced by its affixes between them. This is what " +
        "GGG indexes and what buyers choose on.",
    includeTitle: "A waystone is always searched on its printed totals.",
    stored: item.mapFilters?.find((filter) => filter.text === mapRow.id),
    rowClass: "mod-pseudo"
  });
  // `renderDerivedRow` places the computed placeholder on the min box, which is right for every row
  // that widens downward. A ceiling widens the other way, so the hint belongs on the other box — left
  // on the min it would read as a floor the search never sends.
  // Both boxes are always present on a derived row — the null case on `ModRow` is a mod line with no
  // number in it, which this never is — but the type covers both, so it's tested rather than asserted.
  if (ceiling && row.min && row.max) {
    row.min.placeholder = "";
    row.max.placeholder = String(Math.ceil(mapRow.value / minRatio));
  }
  // Informational only, unlike every other row: map rows are left out of the `ignoredMods` readback
  // and `buildMapFilters` rebuilds these floors from the waystone itself on every search, so an
  // unticked one cannot strand the item. It says the reward floors matched nothing and the price fell
  // back to base type alone — which for a waystone is every other waystone of this tier.
  row.include.checked = !(item.searchedMods !== undefined && item.mapDropped === true);
  row.include.disabled = true;
  return row;
}

/**
 * How many of the priced listings carried this mod, as a `9/10` chip — or null when the item has no
 * coverage recorded (never trade2-priced, or priced before this existed).
 *
 * Deliberately not a tick, and the reason is the query shape: every rung is an `and`, so a listing it
 * returned carries all of the mods it demanded and their chips read `10/10` by construction. The chip
 * is worth reading on the rows the query did **not** demand — a mod the ladder dropped, or one GGG
 * indexes no template for — where it says how many of the listings this price came from carry it
 * anyway, and therefore whether losing it cost anything.
 *
 * What was *asked for* is a set, and it is named by `searchedMods` and `autoDroppedMods`, which is
 * what the checkbox state carries. This stays the measurement alongside it.
 */
function coverageBadge(item: PricedItem, text: string): HTMLElement | null {
  const sample = item.coverageSample ?? 0;
  const entry = item.statCoverage?.find((candidate) => candidate.text === text);
  if (!entry || sample === 0) return null;

  const badge = document.createElement("span");
  badge.className = "badge badge-coverage";
  badge.textContent = `${entry.listings}/${sample}`;
  // None of them carrying it is the interesting case — that mod contributed nothing to this price.
  if (entry.listings === 0) badge.classList.add("badge-partial");
  badge.title =
    `${entry.listings} of the ${sample} listings this price was taken from carry this mod.\n\n` +
    "Every mod the search demanded is on all of them, so this is worth reading on the rows it " +
    "did not: a dropped mod most listings carry anyway cost the price little.";
  return badge;
}

function renderModRow(
  item: PricedItem,
  mod: ParsedMod,
  /** What the search will floor this mod at, from `searchFloorsByMod`. Absent on an item with no
   *  printed roll bracket, where the floor is the roll and this falls back to it. */
  searchMin: number | undefined,
  notSearched = false
): ModRow {
  const el = document.createElement("li");
  // On a waystone the affixes aren't a filter the user can switch on — the search is the reward
  // block or nothing. A live checkbox here would promise something the request never sends.
  //
  // Its own class rather than `.mod-folded`, which `syncFolding` owns and recomputes from the
  // aggregates on every toggle: a waystone has none, so it would clear this again immediately.
  if (notSearched) el.classList.add("mod-unsearchable");

  // Dropped by the tier ladder rather than by the user — the low-tier affixes the search shed to find
  // a market at all. Marked as well as unticked because the two mean different things: `ignoredMods`
  // is a decision the user made and will find where they left it, this one is the app's and is
  // recomputed by every search. The row still ticks, so re-including it is one click.
  const autoDropped = (item.autoDroppedMods ?? []).includes(mod.text);
  if (autoDropped) el.classList.add("mod-auto-dropped");

  // What the last successful search actually asked for. Absent on an item that never ran one — priced
  // by poe.ninja or the exchange, or captured before this was recorded — and absence has to read as
  // "no record", not "nothing was searched", or every such row would open unticked.
  const searched = item.searchedMods;
  const ignored = item.ignoredMods.includes(mod.text);
  // In the record, but neither the user's exclusion nor the ladder's drop: this mod reached no filter
  // group at all. Two ways that happens — GGG's stat reference has no template matching its text, or
  // it was folded into an aggregate the search then had to drop — and the row can't tell which, so
  // the wording below names both rather than picking one.
  const unsearched =
    searched !== undefined && !searched.includes(mod.text) && !ignored && !autoDropped;

  const include = document.createElement("input");
  include.type = "checkbox";
  // The `&& !ignored` arm is not redundant against `searched`. `ignoredMods` persists on *every*
  // reprice while `searchedMods` persists only on one that found a price, so after a failed reprice
  // the record describes a search older than the user's last decision — and without this a mod they
  // had just unticked would tick itself again and silently undo the exclusion.
  include.checked = searched ? searched.includes(mod.text) && !ignored : !ignored && !autoDropped;
  include.disabled = notSearched;
  if (notSearched) {
    include.title =
      "A waystone is priced on the reward totals above. Its affixes produce those totals between " +
      "them, so searching them individually finds only maps with this exact combination — measured " +
      "at zero listings.";
  } else if (autoDropped) {
    include.title =
      "Dropped automatically: nothing was listed carrying this item's full mod set, so the search " +
      "shed its lowest-tier mods until it found a market. The ticked mods are the ones this price " +
      "actually came from. Re-tick it and press Reprice to demand it again.";
  } else if (unsearched) {
    include.title =
      "Not part of the search this price came from. Either GGG's trade stat reference has no filter " +
      "matching this line, or it was folded into an aggregate above that the search then dropped. " +
      "Re-tick it and press Reprice to try asking for it.";
  }

  const body = document.createElement("div");
  body.className = "mod-body";

  const text = document.createElement("span");
  text.className = "mod-text";
  const split = splitModRoll(mod.text);
  if (split) {
    const roll = document.createElement("strong");
    roll.className = "mod-roll";
    roll.textContent = split.roll;
    text.append(split.before, roll, split.after);
  } else {
    text.textContent = mod.text;
  }

  // `.badge` already uppercases, so the ModKind renders as EXPLICIT / IMPLICIT / RUNE untouched.
  const kind = document.createElement("span");
  kind.className = `badge badge-kind badge-kind-${mod.kind}`;
  kind.textContent = mod.kind;

  // Kind and coverage share a line under the mod text; `.mod-body` is a column, so without this row
  // the measurement would sit on its own third line and double every row's height.
  const tags = document.createElement("div");
  tags.className = "mod-tags";
  tags.append(kind);
  // The tier the drop order was decided from, so an automatically dropped row explains itself rather
  // than just appearing unticked. Absent on items captured without Advanced Item Descriptions.
  if (typeof mod.tier === "number") {
    const tier = document.createElement("span");
    tier.className = "badge badge-tier";
    tier.textContent = `T${mod.tier}`;
    tier.title = `Affix tier ${mod.tier} — 1 is the best possible roll.`;
    tags.append(tier);
  }
  if (autoDropped) {
    const dropped = document.createElement("span");
    dropped.className = "badge badge-partial";
    dropped.textContent = "dropped";
    dropped.title =
      "This mod was left out of the search that produced the price, because nothing was listed " +
      "carrying the item's full mod set.";
    tags.append(dropped);
  }
  // Skipped on a waystone, whose affixes already carry `.mod-unsearchable` and their own explanation
  // — every one of them would take this badge, saying the same thing four times over.
  if (unsearched && !notSearched) {
    const missing = document.createElement("span");
    missing.className = "badge badge-partial";
    missing.textContent = "not searched";
    missing.title =
      "This mod was not one of the filters the winning query sent, so the price does not rest on it " +
      "at all. Either GGG indexes nothing matching its text, or it fed an aggregate the search had " +
      "to drop.";
    tags.append(missing);
  }
  const coverage = coverageBadge(item, mod.text);
  if (coverage) tags.append(coverage);

  body.append(text, tags);

  const row: ModRow = { el, text: mod.text, include, min: null, max: null };

  // No number in the line means GGG almost certainly indexes it without a `#` ("Cannot be Frozen"),
  // and a bound on one of those matches nothing at all. Offer no box rather than an inert one.
  if (split) {
    const stored = item.modFilters?.find((filter) => filter.text === mod.text);
    const bounds = document.createElement("div");
    bounds.className = "mod-bounds";

    // The floor the query will use, not the roll the item has — those are now different numbers,
    // and showing the roll would both misreport the search and, on the next Reprice, send the roll
    // back as a bound and undo the floor.
    row.min = boundInput("min", stored ? stored.min : (searchMin ?? Number(split.roll)));
    row.max = boundInput("MAX", stored ? stored.max : null);
    bounds.append(row.min, row.max);
    el.append(include, body, bounds);
  } else {
    el.append(include, body);
  }

  // Ticking a mod off greys its bounds rather than hiding them, so the row doesn't reflow under the
  // cursor while the user is working down the list.
  const syncEnabled = (): void => {
    el.classList.toggle("mod-excluded", !include.checked);
  };
  include.addEventListener("change", syncEnabled);
  syncEnabled();

  return row;
}

function boundInput(placeholder: string, value: number | null): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.placeholder = placeholder;
  input.title =
    placeholder === "min"
      ? "Lowest roll to accept. Lower this to widen the search; clear it to match the stat at any roll."
      : "Highest roll to accept. Usually left empty — a ceiling only helps when pricing a weak roll.";
  if (value !== null) input.value = String(value);
  return input;
}

function renderItemEditor(item: PricedItem, rows: EditorRowsResult): HTMLElement {
  const container = document.createElement("div");
  container.className = "item-edit";

  const { pseudoStats, pseudoMinRatio, mapRows, mapMinRatio } = rows;
  // Computed in the main process from each mod's printed roll bracket — see `searchFloor`. Empty for
  // an item stored before the brackets were parsed, where every row falls back to its own roll.
  const floorByMod = new Map((rows.modFloors ?? []).map((floor) => [floor.text, floor.min]));
  const allMods = itemMods(item);
  const modRows: ModRow[] = [];
  const pseudoRows: ModRow[] = [];
  const mapFilterRows: ModRow[] = [];
  // A waystone is priced on its reward totals alone — its affixes are never sent as filters, so they
  // are shown for reading and nothing else. See buildMapFilters for why they can't usefully be.
  const rewardsOnly = mapRows.length > 0;

  // What to actually *ask* for the item, which the headline cannot answer on its own: that number is
  // the cheapest listing in the sample, and the cheapest listing is routinely one nobody has bought.
  // Lives in the editor rather than on the row because it is a sentence of reasoning, and because the
  // row deliberately carries one number.
  const suggestionRow = document.createElement("div");
  suggestionRow.className = "item-edit-row";
  const suggestionNote = document.createElement("span");
  suggestionNote.className = "status-note";
  const syncSuggestion = (current: PricedItem | null) => {
    // Mirrors applyUpdatedItem: a handler that got nothing back leaves what is on screen alone.
    if (!current) return;
    const suggestion = suggestSellRange(current, 1);
    // Hidden rather than emptied, so the row collapses instead of leaving a gap where a sentence was.
    // `.item-edit-row[hidden]` in the stylesheet is what makes this take effect at all — an author
    // `display` rule outranks the UA stylesheet's `[hidden] { display: none }` at equal specificity.
    suggestionRow.hidden = suggestion === null;
    if (suggestion === null) return;
    // The same unit the headline above it is drawn in, via the same helper the row uses.
    const label = sellSuggestionText(suggestion, rowQuote(current, 1));
    suggestionNote.textContent = label.text;
    suggestionNote.title = label.title;
    // The same warm hue a relaxed price gets. A dead market is not an error, but it is the editor
    // saying the number above it will not sell, which is the thing worth noticing here.
    suggestionNote.classList.toggle("reprice-warning", label.warn);
  };
  syncSuggestion(item);

  if (allMods.length > 0 || rewardsOnly) {
    const modList = document.createElement("ul");
    modList.className = "mod-list";

    // Reward totals and aggregates first: they're the headline numbers, and on a waystone they are
    // the entire search.
    for (const mapRow of mapRows) {
      const row = renderMapRow(item, mapRow, mapMinRatio);
      mapFilterRows.push(row);
      modList.append(row.el);
    }

    for (const stat of pseudoStats) {
      const row = renderPseudoRow(item, stat, pseudoMinRatio);
      pseudoRows.push(row);
      modList.append(row.el);
    }

    for (const mod of allMods) {
      const row = renderModRow(item, mod, floorByMod.get(mod.text), rewardsOnly);
      modRows.push(row);
      modList.append(row.el);
    }

    // A mod folded into a live aggregate isn't being searched on its own, so it reads as inactive
    // until the aggregate above it is unticked. Recomputed on every toggle, in both directions:
    // unticking contributors also drives the aggregate's own total down (and below two contributors
    // the main process stops deriving it at all, which is why the row can't just be static text).
    const syncFolding = (): void => {
      const folded = new Map<string, ModRow>();
      for (const [index, row] of pseudoRows.entries()) {
        const stat = pseudoStats[index]!;
        const live = stat.contributors.filter(
          (contributor) => !isModUnticked(modRows, contributor.text)
        );
        // Mirrors derivePseudoStats, through the number it sends rather than a copy of its rule:
        // most aggregates stop being derived below two contributors, a single-element resistance
        // total holds at one.
        const active = row.include.checked && live.length >= stat.minContributors;
        row.el.classList.toggle("mod-inactive", !active);

        // Both the headline and the floor track the ticked contributors. Leaving the headline at the
        // item's full total while the floor below it fell would be two different numbers for the same
        // thing on one row, and the headline is the one the eye reads first.
        const total = sumAmounts(live);
        const roll = row.el.querySelector(".mod-roll");
        if (roll) roll.textContent = String(total);
        if (row.min) row.min.placeholder = String(Math.floor(total * pseudoMinRatio));
        // And the tiers with them: they name the affixes behind that number, so leaving a badge up
        // for a contributor the user just unticked would credit the total to a roll it no longer has.
        const tags = row.el.querySelector(".mod-tags");
        if (tags) {
          for (const badge of Array.from(tags.querySelectorAll(".badge-tier"))) badge.remove();
          appendTierBadges(tags as HTMLElement, live.map((contributor) => contributor.tier));
        }
        if (!active) continue;
        for (const contributor of stat.contributors) {
          const modRow = modRows.find((candidate) => candidate.text === contributor.text);
          if (modRow) folded.set(contributor.text, modRow);
        }
      }
      for (const row of modRows) row.el.classList.toggle("mod-folded", folded.has(row.text));
    };

    for (const row of [...pseudoRows, ...modRows]) {
      row.include.addEventListener("change", syncFolding);
    }
    syncFolding();

    container.append(modList);

    const repriceRow = document.createElement("div");
    repriceRow.className = "item-edit-row";
    const repriceButton = document.createElement("button");
    repriceButton.type = "button";
    repriceButton.textContent = "Reprice via trade";
    const status = document.createElement("span");
    status.className = "status-note";

    // The one route from a price back to the query it came from. Main builds and opens the URL — this
    // only decides whether there is one to offer.
    const viewButton = document.createElement("button");
    viewButton.type = "button";
    viewButton.textContent = "View search";
    viewButton.title =
      "Opens the trade search this price was taken from, with the mods it used ticked and the ones " +
      "it dropped shown unticked beside them. Mods GGG indexes no filter for can't appear at all. " +
      "GGG expires searches, so an older one may no longer be there.";
    const syncTradeLink = (searchId: string | undefined) => {
      viewButton.hidden = !searchId;
    };
    syncTradeLink(item.tradeSearchId);

    viewButton.addEventListener("click", async () => {
      // Shares the reprice row's status line rather than failing silently — the id is perishable, and
      // a button that does nothing reads as a broken button.
      if (!(await window.poe2Overlay.openTradeSearch(item.id))) {
        status.textContent = "That search is no longer on file.";
      }
    });

    repriceButton.addEventListener("click", async () => {
      // Read off the live DOM rather than out of `item`, which is the copy captured when the editor
      // opened and never sees an edit the user has just made. See the note on `openEditor`.
      // Unticked aggregates ride in the same list as unticked mods — a pseudo id is not a mod line,
      // so the main process can tell them apart without a second field.
      const ignoredMods = [...modRows, ...pseudoRows]
        // A disabled box is not a decision the user made. A waystone's affixes are disabled *and* now
        // open unticked, since none of them is ever searched, so without this the first Reprice would
        // convert every one of them into a permanent user exclusion.
        .filter((row) => !row.include.checked && !row.include.disabled)
        .map((row) => row.text);
      const boundsOf = (rows: ModRow[], skipUntouched: boolean): ModFilter[] =>
        rows
          .filter((row) => row.include.checked && row.min !== null && row.max !== null)
          .map((row): ModFilter => ({
            text: row.text,
            min: boundValue(row.min!),
            max: boundValue(row.max!)
          }))
          // An empty box means different things on the two kinds of row, because they start
          // differently. A mod row's min is *prefilled* with the roll, so clearing it is a decision:
          // "match this stat at any value". An aggregate's is a placeholder showing the floor the
          // search would use anyway, so leaving it empty is not a decision at all — sending it as a
          // null bound would silently turn the 90%-of-total floor into no floor. Type 0 for that.
          .filter((filter) => !skipUntouched || filter.min !== null || filter.max !== null);

      status.textContent = "Searching…";
      const result = await window.poe2Overlay.repriceItem(
        item.id,
        ignoredMods,
        boundsOf(modRows, false),
        boundsOf(pseudoRows, true),
        boundsOf(mapFilterRows, true)
      );

      if (!result.item || result.item.chaosValue === null) {
        // The main process words this: a spent rate-limit budget, no listings for these mods, and
        // an HTTP error each call for something different from the user.
        status.textContent = result.reason ?? "No matching listings found.";
        // Flagged rather than left plain, for the same reason the row is: pressing Reprice into a
        // spent budget means no search went out at all, so the message is about when to try again
        // rather than about the item. The row's badge has already changed to match.
        status.classList.toggle("reprice-warning", result.rateLimited);
        return;
      }

      // Both numbers, because they answer different questions: the sample is what the price came
      // from, the match count is how wide the search that produced it had to cast.
      const relaxed = result.totalMods > 0 && result.matchedMods < result.totalMods;
      // A waystone has no mod filters by design, so the generic "base type only" would report its
      // four reward floors as no search at all — the opposite of what happened.
      const rewardSearch = mapFilterRows.length > 0 && !result.mapDropped;
      status.textContent =
        `Updated from ${result.listings} of ${result.matches} listing(s), ` +
        (rewardSearch
          ? "matching its reward totals."
          : result.totalMods === 0
            ? "base type only."
            : relaxed
              ? `dropping ${result.totalMods - result.matchedMods} mod(s) to find a market, ` +
                `matching all ${result.matchedMods} of the rest.`
              : `matching all ${result.totalMods} mods.`) +
        // Nothing in the mod counts hints at this, and it changes what the number means: the
        // comparables include weak and strong rolls of this base alike.
        (result.defencesDropped ? " Nothing matched its Armour/Evasion, so that was ignored." : "") +
        // Says why five mods produced two filters, which otherwise reads as mods having gone missing.
        (result.pseudoStats.length > 0
          ? ` Searched as ${result.pseudoStats.map((stat) => stat.label).join(" and ")}.`
          : "") +
        (result.pseudoDropped ? " Nothing matched its resistance/life totals, so those were ignored." : "") +
        // For a waystone this is the whole search, so saying it matters more than the others: what
        // is left is every waystone of this tier, whatever it rolled.
        (result.mapDropped ? " Nothing matched its reward totals, so it's priced on tier alone." : "");
      status.classList.toggle(
        "reprice-warning",
        relaxed ||
          (result.totalMods === 0 && !rewardSearch) ||
          result.defencesDropped ||
          result.pseudoDropped ||
          result.mapDropped
      );
      // Not optional: `applyUpdatedItem` re-renders the list, but the editor is moved rather than
      // rebuilt (see `openEditor`), so this button would otherwise keep offering the previous search
      // — a query that produced a different number from the one now on the row.
      syncTradeLink(result.item.tradeSearchId);
      syncSuggestion(result.item);
      applyUpdatedItem(result.item);
    });

    repriceRow.append(repriceButton, viewButton, status);
    container.append(repriceRow);
  }

  suggestionRow.append(suggestionNote);
  container.append(suggestionRow);

  const manualRow = document.createElement("div");
  manualRow.className = "item-edit-row";

  const manualLabel = document.createElement("span");
  // Values are stored per unit and multiplied by the stack; without the label a user typing the
  // total for a 20-stack silently gets 20x that.
  manualLabel.textContent = item.stackSize > 1 ? "chaos each:" : "chaos:";

  const manualInput = document.createElement("input");
  manualInput.type = "number";
  manualInput.placeholder = "value";
  manualInput.min = "0";
  if (item.manualChaosValue !== null) manualInput.value = String(item.manualChaosValue);

  const setButton = document.createElement("button");
  setButton.type = "button";
  setButton.textContent = "Set";

  const manualStatus = document.createElement("span");
  manualStatus.className = "status-note";

  setButton.addEventListener("click", async () => {
    const raw = manualInput.value.trim();
    // Empty clears the override; anything else has to be a real non-negative number. Silently
    // coercing junk to null looked identical to "cleared" and gave the user no way to tell.
    let value: number | null = null;
    if (raw !== "") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        manualStatus.textContent = "Enter a number, or leave blank to clear.";
        return;
      }
      value = parsed;
    }

    manualStatus.textContent = "";
    const result = await window.poe2Overlay.setManualPrice(item.id, value);
    syncSuggestion(result.item);
    applyUpdatedItem(result.item);
  });

  manualRow.append(manualLabel, manualInput, setButton, manualStatus);
  container.append(manualRow);

  return container;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

searchEl.addEventListener("input", () => {
  searchText = searchEl.value;
  scheduleRender();
});

sortEl.addEventListener("change", () => {
  sortMode = sortEl.value as typeof sortMode;
  scheduleRender();
});

unpricedEl.addEventListener("change", () => {
  unpricedOnly = unpricedEl.checked;
  scheduleRender();
});

function exportCsv(): void {
  const header = ["name", "baseType", "rarity", "itemClass", "stackSize", "chaosValue", "priceSource", "capturedAt"];
  const rows = allItems.map((item) =>
    [
      item.name,
      item.baseType,
      item.rarity,
      item.itemClass ?? "",
      String(item.stackSize),
      totalValue(item) ?? "",
      item.manualChaosValue !== null ? "manual" : item.priceSource,
      new Date(item.capturedAt).toISOString()
    ]
      .map((field) => `"${String(field).replace(/"/g, '""')}"`)
      .join(",")
  );

  const blob = new Blob([[header.join(","), ...rows].join("\r\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `poe2-loot-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

exportButton.addEventListener("click", exportCsv);

/**
 * Wipes everything recorded. Two-step rather than immediate: this deletes every map and every item
 * with no undo in the app, and the panel is click-through-toggled, so a single stray click
 * shouldn't be able to do it. A native confirm dialog isn't an option — the overlay window is
 * frameless and non-focusable outside interactive mode, so a modal can end up behind the game.
 */
function wireClearButton(): void {
  let armed = false;
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    armed = false;
    if (disarmTimer) clearTimeout(disarmTimer);
    disarmTimer = null;
    clearButton.textContent = "Clear all";
    clearButton.classList.remove("danger");
  };

  clearButton.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      clearButton.textContent = "Confirm clear?";
      clearButton.classList.add("danger");
      disarmTimer = setTimeout(disarm, 4000);
      return;
    }

    disarm();
    await window.poe2Overlay.clearHistory();

    // Every piece of view state that was fed by the now-deleted data.
    allItems = [];
    openEditor = null;
    renderList();
  });
}

wireClearButton();

/**
 * Forces the poe.ninja pull that otherwise waits out `poeNinja.refreshIntervalMs`.
 *
 * Every state it reports goes **in the button's own label**, the same choice `wireClearButton` makes
 * and for the same reason: this window is frameless and non-focusable outside interactive mode, so a
 * native dialog can end up behind the game.
 *
 * Success needs no message of its own — the main process broadcasts `OVERLAY_STATUS` off the same
 * refresh, so the header's age line reads "Prices: just updated" by the time this resolves. Failure
 * does, because nothing else on screen changes: the prices are as stale as they were, which is
 * indistinguishable from a button that did nothing.
 */
function wireRefreshButton(): void {
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;

  refreshButton.addEventListener("click", async () => {
    if (restoreTimer) clearTimeout(restoreTimer);
    // Disabled for the duration rather than left clickable: `PoeNinjaClient.refresh` would hand a
    // second press the same promise anyway, so the press would do nothing while looking like it had.
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing…";

    let updated = false;
    try {
      ({ updated } = await window.poe2Overlay.refreshPrices());
    } catch {
      updated = false;
    }

    refreshButton.disabled = false;
    refreshButton.textContent = updated ? "Refresh prices" : "poe.ninja unreachable";
    if (!updated) {
      restoreTimer = setTimeout(() => {
        refreshButton.textContent = "Refresh prices";
        restoreTimer = null;
      }, 4000);
    }
  });
}

wireRefreshButton();

async function load(): Promise<void> {
  const [status, items] = await Promise.all([
    window.poe2Overlay.getStatus(),
    window.poe2Overlay.getAllItems()
  ]);

  // A push may have arrived while those were in flight; it's newer than anything the store returned.
  const pushed = allItems;
  allItems = items.concat(pushed.filter((item) => !items.some((stored) => stored.id === item.id)));

  applyStatus(status);
}

void load();
