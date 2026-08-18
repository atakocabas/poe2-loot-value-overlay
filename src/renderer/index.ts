// The overlay panel. Loads as a plain <script> after common.js (no bundler, contextIsolation on, no
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
const sessionTotalEl = document.getElementById("session-total")!;
const sessionTotalLineEl = document.getElementById("session-total-line")!;
const sessionStatusEl = document.getElementById("session-status")!;
const priceStatusEl = document.getElementById("price-status")!;
const rateStatusEl = document.getElementById("rate-status")!;
const itemListEl = document.getElementById("item-list")!;
const pendingListEl = document.getElementById("pending-list")!;
const listEmptyEl = document.getElementById("list-empty")!;
const searchEl = document.getElementById("list-search") as HTMLInputElement;
const sortEl = document.getElementById("list-sort") as HTMLSelectElement;
const unpricedEl = document.getElementById("list-unpriced") as HTMLInputElement;
const exportButton = document.getElementById("export-csv") as HTMLButtonElement;
const clearButton = document.getElementById("clear-history") as HTMLButtonElement;

/** Every recorded item, in capture order. Reloaded from the store only on load and after a clear. */
let allItems: PricedItem[] = [];
/** The map in progress (or the last one), for the header alone — the list is not scoped to it. */
let latestSession: Session | null = null;
let lastZoneIsHideout = false;
let pricesFetchedAt: number | null = null;

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
 * Whether a map is running — the one thing that separates the panel's two states.
 *
 * A duplicate of `isMapSession` in `shared/session.ts`, inline for the usual reason: this page loads
 * as a plain <script> and can't import shared modules at runtime, exactly as `effectiveChaosValue` is
 * duplicated in common.ts. The shared copy carries the argument and is the one under test.
 *
 * **An active session is not enough.** Capturing an item anywhere opens one so the item has somewhere
 * to be filed, including in a hideout — testing only `endedAt` collapsed the panel to its in-map form
 * on any Ctrl+C outside a map, until the next zone change closed that session.
 */
function isInMap(): boolean {
  if (!latestSession || latestSession.endedAt !== null) return false;
  return latestSession.zoneName !== null || latestSession.manual === true;
}

function renderSessionStatus(): void {
  const isActive = isInMap();
  sessionStatusEl.classList.toggle("active", isActive);
  sessionStatusEl.classList.toggle("hideout", !isActive && lastZoneIsHideout);
  if (isActive) {
    sessionStatusEl.textContent = latestSession!.zoneName
      ? `In map: ${latestSession!.zoneName}`
      : "Map in progress (started manually)";
  } else if (lastZoneIsHideout) {
    sessionStatusEl.textContent = "In Hideout";
  } else {
    sessionStatusEl.textContent = "No active map";
  }
}

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
 * How long the total survives a map ending before it's taken down.
 *
 * Chaining maps arrives as SESSION_UPDATE(ended) then SESSION_UPDATE(new), with two real awaits
 * between them in the main process — it ends the old session and starts the new one either side of a
 * store write — so the panel can genuinely paint the out-of-map state mid-transition. Without a
 * grace the total blinks every time you take the next map.
 */
const MAP_END_GRACE_MS = 400;
let leaveMapTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether the panel is in its minimal, heads-up form. **This is the resting state**, which is why it
 * starts true and why `#panel` ships with the class in index.html.
 *
 * Driven by `OverlayStatus.expanded` — the `toggleList` hotkey — and by nothing else. Deliberately
 * *not* derived from `isInMap()`: the panel shows the last capture wherever you are, and opening the
 * full list is a decision rather than a side effect of which zone you happen to be in.
 */
let minimalMode = true;

/**
 * Shows or hides the map's running total.
 *
 * Nothing to do with the panel's *form* any more — the two used to be one function, and came apart
 * when the form became a keypress. This half keeps the grace period because it reacts to events
 * rather than to the user: chaining maps arrives as SESSION_UPDATE(ended) then SESSION_UPDATE(new),
 * with real awaits between them, so without it the total blinks on every transition. Showing is
 * immediate, hiding is deferred, and the timer **re-checks the condition when it fires** rather than
 * trusting the decision that armed it — like `applyOverlayVisibility()` in the main process.
 */
function applyMapState(): void {
  if (isInMap()) {
    if (leaveMapTimer !== null) {
      clearTimeout(leaveMapTimer);
      leaveMapTimer = null;
    }
    sessionTotalLineEl.classList.remove("hidden");
    return;
  }

  // Nothing on screen to take down (the cold-start case, where the first session is an ended one),
  // or a hide is already armed.
  if (leaveMapTimer !== null || sessionTotalLineEl.classList.contains("hidden")) return;
  leaveMapTimer = setTimeout(() => {
    leaveMapTimer = null;
    if (!isInMap()) sessionTotalLineEl.classList.add("hidden");
  }, MAP_END_GRACE_MS);
}

/**
 * Switches the panel between its two forms: the heads-up display it rests in, and the full panel —
 * filters, the whole list, Export/Clear, per-row Edit — that the `toggleList` hotkey opens.
 * `MINIMAL_ROWS` and the `#panel.minimal` block in style.css are the two halves of that.
 *
 * No grace and no re-check, unlike `applyMapState`: this only ever runs because the user pressed a
 * key, and a keypress should land immediately.
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

/**
 * The running total of the *current map*, not of the list — the list spans every map ever run, which
 * is why this is hidden outright rather than falling back to a total of everything.
 *
 * Every path that mutates `latestSession` already calls this, so it is also where the two states are
 * applied from; nothing else has to remember to.
 */
function renderSessionTotal(): void {
  sessionTotalEl.textContent = latestSession ? formatValue(latestSession.totalChaosValue) : formatValue(0);
  applyMapState();
}

window.poe2Overlay.onSessionUpdate((session) => {
  // Header only. A new map deliberately does *not* reset the list any more — it just prepends to it.
  latestSession = session;
  renderSessionTotal();
  renderSessionStatus();
});

window.poe2Overlay.onZoneStatus(({ isHideout }) => {
  lastZoneIsHideout = isHideout;
  renderSessionStatus();
});

function applyStatus(status: OverlayStatus): void {
  rates = status.rates;
  displayCurrency = status.displayCurrency;
  pricesFetchedAt = status.pricesFetchedAt;
  panel.classList.toggle("interactive", status.interactive);
  setMinimalMode(!status.expanded);
  panel.style.width = `${status.panel.width}px`;
  panel.style.maxHeight = `${status.panel.maxHeightPercent}vh`;
  // A class rather than an inline style, unlike the two above: the side carries no number of its
  // own, and the offset from the edge is the same 24px either way.
  panel.classList.toggle("left", status.panel.position === "left");
  renderPriceStatus();
  renderRateStatus();
  renderSessionTotal();
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
 * wholesale rather than patched, and one capture can produce a PRICED_ITEM and a SESSION_UPDATE
 * plus a status push; with an unbounded list that is a full rebuild each, for one visible change.
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

function renderItemRow({ item, count, total }: ItemGroup): HTMLElement {
  const row = document.createElement("div");
  row.className = "item-row";

  const top = document.createElement("div");
  top.className = "item-row-top";

  const value = document.createElement("span");
  value.className = total === null ? "item-value unpriced" : "item-value";
  value.textContent = total === null ? "unpriced" : formatValue(total);

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
  const median = medianValueEl(item, count, total);
  if (median) top.append(median);
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
 * them. Both editor actions return the stored item and its recomputed session, so there is nothing
 * left to ask the store for.
 */
function applyUpdatedItem(updated: PricedItem | null, session: Session | null): void {
  if (updated) allItems = allItems.map((existing) => (existing.id === updated.id ? updated : existing));
  if (session && latestSession && session.id === latestSession.id) {
    latestSession = session;
    renderSessionTotal();
  }
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
    rowClass: "mod-pseudo"
  });
  row.include.checked = !item.ignoredMods.includes(stat.id);
  return row;
}

/**
 * One of a waystone's printed reward totals — what it is actually traded on.
 *
 * No checkbox behaviour to speak of: unlike an aggregate there is nothing to fall back to, since the
 * affixes that produced this number are never searched. It stays ticked and disabled.
 */
function renderMapRow(item: PricedItem, mapRow: MapRow, minRatio: number): ModRow {
  const row = renderDerivedRow({
    id: mapRow.id,
    label: mapRow.label,
    total: mapRow.value,
    minRatio,
    badge: "reward",
    badgeTitle:
      "A total the game prints on the waystone, produced by its affixes between them. This is what " +
      "GGG indexes and what buyers choose on.",
    includeTitle: "A waystone is always searched on its reward totals.",
    stored: item.mapFilters?.find((filter) => filter.text === mapRow.id),
    rowClass: "mod-pseudo"
  });
  row.include.disabled = true;
  return row;
}

/**
 * How many of the priced listings carried this mod, as a `9/10` chip — or null when the item has no
 * coverage recorded (never trade2-priced, or priced before this existed).
 *
 * Deliberately not a tick. A count rung asks for "at least N of M", so different listings satisfy
 * different subsets and there is no set of mods that "was used"; a tick would assert one exists.
 * What the number does answer is the question behind that — which of these mods the comparables
 * actually share, and therefore which ones are worth unticking.
 *
 * The tier ladder's drop rungs *do* name a set, but they name it by what they removed, which is what
 * `autoDroppedMods` and the checkbox state carry. This stays the measurement of what remained.
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
    "The search asked for a number of mods, not these specific ones, so listings differ in which " +
    "they carry. A low count means the price barely rests on this mod.";
  return badge;
}

function renderModRow(item: PricedItem, mod: ParsedMod, notSearched = false): ModRow {
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

  const include = document.createElement("input");
  include.type = "checkbox";
  include.checked = !item.ignoredMods.includes(mod.text) && !autoDropped;
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

    row.min = boundInput("min", stored ? stored.min : Number(split.roll));
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
  const allMods = itemMods(item);
  const modRows: ModRow[] = [];
  const pseudoRows: ModRow[] = [];
  const mapFilterRows: ModRow[] = [];
  // A waystone is priced on its reward totals alone — its affixes are never sent as filters, so they
  // are shown for reading and nothing else. See buildMapFilters for why they can't usefully be.
  const rewardsOnly = mapRows.length > 0;

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
      const row = renderModRow(item, mod, rewardsOnly);
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
        // Mirrors derivePseudoStats: below two contributors there is nothing left to aggregate.
        const active = row.include.checked && live.length >= 2;
        row.el.classList.toggle("mod-inactive", !active);

        // Both the headline and the floor track the ticked contributors. Leaving the headline at the
        // item's full total while the floor below it fell would be two different numbers for the same
        // thing on one row, and the headline is the one the eye reads first.
        const total = sumAmounts(live);
        const roll = row.el.querySelector(".mod-roll");
        if (roll) roll.textContent = String(total);
        if (row.min) row.min.placeholder = String(Math.floor(total * pseudoMinRatio));
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
      "Opens the trade search this price was taken from. GGG expires searches, so an older one may " +
      "no longer be there.";
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
        .filter((row) => !row.include.checked)
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
        return;
      }

      // Both numbers, because they answer different questions: the sample is what the median came
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
              ? `matching only ${result.matchedMods} of ${result.totalMods} mods — a ballpark.`
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
      applyUpdatedItem(result.item, result.session);
    });

    repriceRow.append(repriceButton, viewButton, status);
    container.append(repriceRow);
  }

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
    applyUpdatedItem(result.item, result.session);
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

    // Every piece of view state that was fed by the now-deleted data. Missing latestSession here
    // would leave the header showing the total of a session that no longer exists.
    allItems = [];
    latestSession = null;
    openEditor = null;
    renderSessionTotal();
    renderSessionStatus();
    renderList();
  });
}

wireClearButton();

/**
 * Sessions come back newest-first, so the first is the map in progress (or the one that just
 * ended). It's fetched purely for the header — nothing else here is scoped to a session.
 */
async function load(): Promise<void> {
  const [status, sessions, items] = await Promise.all([
    window.poe2Overlay.getStatus(),
    window.poe2Overlay.getHistory(),
    window.poe2Overlay.getAllItems()
  ]);

  // A push may have arrived while those were in flight; it's newer than anything the store returned.
  const pushed = allItems;
  allItems = items.concat(pushed.filter((item) => !items.some((stored) => stored.id === item.id)));
  if (sessions.length > 0) latestSession = sessions[0];

  applyStatus(status);
  renderSessionStatus();
}

void load();
