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
const sessionStatusEl = document.getElementById("session-status")!;
const priceStatusEl = document.getElementById("price-status")!;
const rateStatusEl = document.getElementById("rate-status")!;
const itemListEl = document.getElementById("item-list")!;
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

// ---------------------------------------------------------------------------
// Header status
// ---------------------------------------------------------------------------

function renderSessionStatus(): void {
  const isActive = !!latestSession && latestSession.endedAt === null;
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

/** The running total of the *current map*, not of the list — the list spans every map ever run. */
function renderSessionTotal(): void {
  sessionTotalEl.textContent = latestSession ? formatValue(latestSession.totalChaosValue) : formatValue(0);
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
  panel.style.width = `${status.panel.width}px`;
  panel.style.maxHeight = `${status.panel.maxHeightPercent}vh`;
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

function renderList(): void {
  // replaceChildren resets scrollTop to 0. Without this a pickup arriving while the user is reading
  // something further down yanks them back to the top of a list that never stops growing.
  const scrollTop = itemListEl.scrollTop;

  const groups = visibleGroups();
  itemListEl.replaceChildren(...groups.map((group) => renderItemRow(group)));
  itemListEl.scrollTop = scrollTop;

  listEmptyEl.classList.toggle("hidden", groups.length > 0);
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
  toggle.addEventListener("click", () => {
    openEditor =
      openEditor?.itemId === item.id ? null : { itemId: item.id, el: renderItemEditor(item) };
    scheduleRender();
  });

  top.append(itemNameEl(item, count), value, toggle);
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

function renderItemEditor(item: PricedItem): HTMLElement {
  const container = document.createElement("div");
  container.className = "item-edit";

  const allMods = [...item.implicitMods, ...item.explicitMods];
  const modCheckboxes: HTMLInputElement[] = [];

  if (allMods.length > 0) {
    const modList = document.createElement("ul");
    modList.className = "mod-list";

    for (const mod of allMods) {
      const li = document.createElement("li");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !item.ignoredMods.includes(mod);
      checkbox.dataset.mod = mod;
      modCheckboxes.push(checkbox);

      const text = document.createElement("span");
      text.textContent = mod;

      li.append(checkbox, text);
      modList.append(li);
    }

    container.append(modList);

    const repriceRow = document.createElement("div");
    repriceRow.className = "item-edit-row";
    const repriceButton = document.createElement("button");
    repriceButton.type = "button";
    repriceButton.textContent = "Reprice via trade";
    const status = document.createElement("span");
    status.className = "status-note";

    repriceButton.addEventListener("click", async () => {
      const ignoredMods = modCheckboxes.filter((cb) => !cb.checked).map((cb) => cb.dataset.mod!);
      status.textContent = "Searching…";
      const result = await window.poe2Overlay.repriceItem(item.id, ignoredMods);

      if (!result.item || result.item.chaosValue === null) {
        // The main process words this: a spent rate-limit budget, no listings for these mods, and
        // an HTTP error each call for something different from the user.
        status.textContent = result.reason ?? "No matching listings found.";
        return;
      }

      // Both numbers, because they answer different questions: the sample is what the median came
      // from, the match count is how wide the search that produced it had to cast.
      const relaxed = result.totalMods > 0 && result.matchedMods < result.totalMods;
      status.textContent =
        `Updated from ${result.listings} of ${result.matches} listing(s), ` +
        (result.totalMods === 0
          ? "base type only."
          : relaxed
            ? `matching only ${result.matchedMods} of ${result.totalMods} mods — a ballpark.`
            : `matching all ${result.totalMods} mods.`) +
        // Nothing in the mod counts hints at this, and it changes what the number means: the
        // comparables include weak and strong rolls of this base alike.
        (result.defencesDropped ? " Nothing matched its Armour/Evasion, so that was ignored." : "");
      status.classList.toggle("reprice-warning", relaxed || result.totalMods === 0 || result.defencesDropped);
      applyUpdatedItem(result.item, result.session);
    });

    repriceRow.append(repriceButton, status);
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
