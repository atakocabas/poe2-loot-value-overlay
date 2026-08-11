// Value/format/row helpers for the renderer, loaded as a plain <script> ahead of index.js. Like
// index.ts it must not contain ANY top-level import/export statement — even a type-only
// `import type` marks the file as an ES module to tsc, which then emits `exports` boilerplate that
// throws in a non-module <script> context. So everything here is a plain global, and shared types
// come from the `declare global` block in global.d.ts. Both files therefore share one global scope
// as far as tsc is concerned: a top-level name declared in both is a compile error, not a clash.
//
// The helpers below are therefore duplicated from shared/ rather than imported:
//   effectiveValue/totalValue  <- shared/effective-value.ts
//   formatNumber/formatValue   <- shared/format-value.ts  (tested in test/format-value.test.ts)
//   formatHubRates             <- shared/format-value.ts  (tested in test/format-value.test.ts)
// Keep them in sync with those modules.

type Rates = { chaosPerDivine: number; exaltedPerDivine: number };
type DisplayCurrency = "auto" | "exalted" | "chaos" | "divine";

/** Set from OVERLAY_STATUS on both pages; every value on screen is formatted through them. */
let rates: Rates | null = null;
let displayCurrency: DisplayCurrency = "auto";

function effectiveValue(item: PricedItem): number | null {
  return item.manualChaosValue ?? item.chaosValue;
}

function totalValue(item: PricedItem): number | null {
  const perUnit = effectiveValue(item);
  return perUnit === null ? null : perUnit * item.stackSize;
}

const UNIT_LABEL: Record<Exclude<DisplayCurrency, "auto">, string> = {
  exalted: "ex",
  chaos: "c",
  divine: "div"
};

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return "<0.01";
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const fixed = value.toFixed(decimals);
  const trimmed = decimals > 0 ? fixed.replace(/\.?0+$/, "") : fixed;
  return Number(trimmed).toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function convertFromChaos(chaos: number, r: Rates, unit: Exclude<DisplayCurrency, "auto">): number {
  if (unit === "chaos") return chaos;
  const divine = chaos / r.chaosPerDivine;
  return unit === "divine" ? divine : divine * r.exaltedPerDivine;
}

function formatValue(chaos: number | null): string {
  if (chaos === null) return "?";
  if (!rates || !Number.isFinite(rates.chaosPerDivine) || rates.chaosPerDivine <= 0) {
    return `${formatNumber(chaos)}c`;
  }
  const unit =
    displayCurrency === "auto" ? (chaos / rates.chaosPerDivine >= 1 ? "divine" : "exalted") : displayCurrency;
  return `${formatNumber(convertFromChaos(chaos, rates, unit))}${UNIT_LABEL[unit]}`;
}

// Direction matters: exalted-per-chaos is exaltedPerDivine / chaosPerDivine (~48), not its
// reciprocal (~0.02). See the doc comment on the shared original.
function formatHubRates(r: Rates | null): string | null {
  if (!r) return null;
  const { chaosPerDivine, exaltedPerDivine } = r;
  if (!Number.isFinite(chaosPerDivine) || chaosPerDivine <= 0) return null;
  if (!Number.isFinite(exaltedPerDivine) || exaltedPerDivine <= 0) return null;

  return [
    `1div = ${formatNumber(chaosPerDivine)}${UNIT_LABEL.chaos}`,
    `1div = ${formatNumber(exaltedPerDivine)}${UNIT_LABEL.exalted}`,
    `1${UNIT_LABEL.chaos} = ${formatNumber(exaltedPerDivine / chaosPerDivine)}${UNIT_LABEL.exalted}`
  ].join(" · ");
}

// ---------------------------------------------------------------------------
// Item tooltip
// ---------------------------------------------------------------------------

const tooltipEl = document.getElementById("item-tooltip")!;

/**
 * The full clipboard text is already stored on every item, so the in-game tooltip can be shown for
 * free. It's the only way to see mods, item level, sockets and quality — the row itself has room
 * for a name and a price and nothing else.
 */
function attachTooltip(el: HTMLElement, item: PricedItem): void {
  el.addEventListener("mouseenter", () => {
    if (!item.rawText) return;
    tooltipEl.textContent = item.rawText;
    tooltipEl.classList.remove("hidden");
    positionTooltip(el);
  });
  el.addEventListener("mouseleave", () => tooltipEl.classList.add("hidden"));
}

/**
 * Left of the hovered row where there's room, right of it otherwise. The side isn't fixed because
 * the tooltip is far wider than the panel: anchored to a panel near the left edge it would run off
 * screen, and the item text it holds is the only place mods are readable.
 */
function positionTooltip(anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = tooltipEl.offsetWidth;
  const height = tooltipEl.offsetHeight;
  const left = rect.left - width - 8;
  tooltipEl.style.left = `${left >= 4 ? left : Math.min(rect.right + 8, window.innerWidth - width - 4)}px`;
  tooltipEl.style.top = `${Math.min(Math.max(4, rect.top), window.innerHeight - height - 4)}px`;
}

// ---------------------------------------------------------------------------
// Shared row rendering
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<string, string> = {
  poeninja: "ninja",
  currencyExchange: "exchange",
  trade2: "trade",
  unpriced: "unpriced"
};

function sourceBadge(item: PricedItem): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "badge";
  if (item.manualChaosValue !== null) {
    badge.textContent = "manual";
    badge.classList.add("badge-manual");
    return badge;
  }

  badge.textContent = SOURCE_LABEL[item.priceSource] ?? item.priceSource;
  if (item.priceSource === "unpriced") badge.classList.add("badge-unpriced");

  // A trade2 price that couldn't find every mod is a price for items *like* this one, and there is
  // nothing else on the row to say so — the number looks exactly as confident either way.
  const match = item.modMatch;
  if (match && match.total > 0 && match.matched < match.total) {
    badge.textContent += ` ${match.matched}/${match.total}`;
    badge.classList.add("badge-partial");
    badge.title =
      `No listing had all ${match.total} of this item's mods, so the price comes from ones ` +
      `sharing ${match.matched}. Treat it as a ballpark.`;
  }

  // Same argument, different cause: nothing was listed at this item's own armour/evasion, so the
  // price averages a weak roll of this base together with a strong one.
  if (item.defencesDropped) {
    badge.textContent += " ~def";
    badge.classList.add("badge-partial");
    badge.title =
      (badge.title ? `${badge.title}\n\n` : "") +
      "No listing matched this item's Armour/Evasion/Energy Shield totals, so the price ignores " +
      "them and compares this base and these mods at any defences.";
  }
  return badge;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function itemNameEl(item: PricedItem, count?: number): HTMLElement {
  const total = count ?? item.stackSize;
  const label = document.createElement("span");
  label.className = `item-name rarity-${item.rarity}`;
  label.textContent = total > 1 ? `${item.name} x${total}` : item.name;
  if (item.corrupted) {
    const corrupted = document.createElement("span");
    corrupted.className = "corrupted-mark";
    corrupted.textContent = " ⊘";
    corrupted.title = "Corrupted";
    label.append(corrupted);
  }
  return label;
}

/**
 * The base type is what identifies a rare — "Doom Grip" says nothing, "Titan Gauntlets" says what
 * dropped. Suppressed when it just repeats the name, as it does for currency and gems.
 */
function itemSubtitle(item: PricedItem): HTMLElement | null {
  const parts: string[] = [];
  if (item.baseType && item.baseType !== item.name) parts.push(item.baseType);
  if (item.waystoneTier !== null) parts.push(`T${item.waystoneTier}`);
  if (item.gemLevel !== null) parts.push(`Lv${item.gemLevel}`);
  if (item.quality) parts.push(`+${item.quality}%`);
  if (parts.length === 0) return null;

  const sub = document.createElement("div");
  sub.className = "item-sub";
  sub.textContent = parts.join(" · ");
  return sub;
}

interface ItemGroup {
  item: PricedItem;
  count: number;
  total: number | null;
}

/**
 * Identical stackable drops are folded into one row. Five separate Exalted Orb pickups are five
 * lines of noise; what the user wants to know is how many dropped in this map.
 */
function groupItems(items: PricedItem[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();

  for (const item of items) {
    const value = totalValue(item);
    // Only fold rows that are genuinely interchangeable — anything with mods or a manual price is
    // its own thing even if the name matches.
    const groupable =
      item.implicitMods.length === 0 &&
      item.explicitMods.length === 0 &&
      item.manualChaosValue === null &&
      (item.rarity === "Currency" || item.rarity === "Normal");
    const key = groupable ? `${item.name}|${item.priceSource}` : item.id;

    const existing = groups.get(key);
    if (existing) {
      existing.count += item.stackSize;
      existing.total = existing.total === null || value === null ? null : existing.total + value;
    } else {
      groups.set(key, { item, count: item.stackSize, total: value });
    }
  }

  return [...groups.values()];
}

/** Unpriced sorts last rather than as zero, so it doesn't bury the cheap-but-known items. */
function byValueDesc(a: ItemGroup, b: ItemGroup): number {
  if (a.total === null || b.total === null) return (a.total === null ? 1 : 0) - (b.total === null ? 1 : 0);
  return b.total - a.total;
}
