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
//   itemMods                   <- shared/mods.ts  (modsOf; tested in test/mods.test.ts)
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

type ListingQuote = { amount: number; currency: string };

/** The three GGG currency ids this app can label; anything else falls back to the magnitude rule. */
const QUOTE_UNITS: Record<string, Exclude<DisplayCurrency, "auto">> = {
  chaos: "chaos",
  exalted: "exalted",
  divine: "divine"
};

/**
 * The unit a value is shown in. An explicit setting wins; on `auto` the listing's own currency wins
 * next, and the size of the number decides when there is no listing behind it. See the shared
 * original for the argument.
 */
function pickDisplayUnit(chaos: number, r: Rates, quote?: ListingQuote | null): Exclude<DisplayCurrency, "auto"> {
  if (displayCurrency !== "auto") return displayCurrency;

  const quoted = quote ? QUOTE_UNITS[quote.currency] : undefined;
  if (quoted) return quoted;

  if (chaos / r.chaosPerDivine >= 1) return "divine";
  return chaos >= 1 ? "chaos" : "exalted";
}

function formatValue(chaos: number | null, quote?: ListingQuote | null): string {
  if (chaos === null) return "?";
  if (!rates || !Number.isFinite(rates.chaosPerDivine) || rates.chaosPerDivine <= 0) {
    return `${formatNumber(chaos)}c`;
  }
  const unit = pickDisplayUnit(chaos, rates, quote);
  return `${formatNumber(convertFromChaos(chaos, rates, unit))}${UNIT_LABEL[unit]}`;
}

/**
 * The unit a *row* is shown in, and the one its median parenthetical has to share.
 *
 * Only a single, unfolded, trade2-priced item follows its listing: `count > 1` means the headline is
 * a summed group total, `stackSize > 1` means it is a stack, and a manual price replaces the trade
 * figure entirely — in all three the quote no longer describes the number on screen. Those are the
 * same guards `medianValueEl` applies, for the same reason.
 */
function rowQuote(item: PricedItem, count: number): ListingQuote | null {
  if (count !== 1 || item.stackSize !== 1) return null;
  if (item.priceSource !== "trade2" || item.manualChaosValue !== null) return null;
  return item.tradeListingQuote ?? null;
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
function attachTooltip(el: HTMLElement, item: ParsedItem): void {
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
  if (item.priceSource === "unpriced") {
    // "unpriced" reads as a fact about the item — that nothing on the market matches it. A rate limit
    // means the opposite: nobody has looked yet, and the answer arrives by waiting. Same badge slot,
    // different word, because the two ask different things of the reader.
    if (item.unpricedReason === "rateLimited") {
      badge.textContent = "rate limited";
      badge.classList.add("badge-ratelimited");
      badge.title =
        "No trade search went out for this item — GGG rate-limits by IP and the budget was spent. " +
        "Press Edit and Reprice once the window refills; nothing about the item itself is wrong.";
    } else {
      badge.classList.add("badge-unpriced");
    }
  }

  // A trade2 price that couldn't find every mod is a price for items *like* this one, and there is
  // nothing else on the row to say so — the number looks exactly as confident either way.
  const match = item.modMatch;
  if (match && match.total > 0 && match.matched < match.total) {
    badge.textContent += ` ${match.matched}/${match.total}`;
    badge.classList.add("badge-partial");
    // Dropped, not merely un-matched. Every listing behind this price carries *all* of the surviving
    // mods — the search shed the rest to find a market, and Edit names exactly which.
    badge.title =
      `Nothing was listed with all ${match.total} of this item's mods, so the search dropped ` +
      `${match.total - match.matched} of them and priced it off listings carrying all ` +
      `${match.matched} of the rest. Press Edit to see which were dropped.`;
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

  // And again for the derived aggregates — a price found only by ignoring an 83% resistance total is
  // a price for a much weaker item, and nothing else on the row would say so.
  if (item.pseudoDropped) {
    badge.textContent += " ~agg";
    badge.classList.add("badge-partial");
    badge.title =
      (badge.title ? `${badge.title}\n\n` : "") +
      "No listing matched this item's total resistance/life/attributes, so the price ignores those " +
      "totals and compares this base and these mods at any of them.";
  }

  // Worse than the other two on a waystone, because the reward totals are the *only* thing it is
  // searched on — dropping them leaves the tier and nothing else.
  if (item.mapDropped) {
    badge.textContent += " ~map";
    badge.classList.add("badge-partial");
    badge.title =
      (badge.title ? `${badge.title}\n\n` : "") +
      "No listing matched this waystone's Item Rarity / Pack Size / Monster Rarity / Drop Chance, " +
      "so the price is off every waystone of this tier regardless of what it rolled.";
  }
  return badge;
}

/**
 * The `(18ex)` beside a trade2 price — the median of the same sampled listings the headline is the
 * cheapest of. The gap between the two is the point: a floor far below the median of its own sample
 * is one optimistic seller rather than a market, and a single number cannot say that.
 *
 * Returns null in every case where the parenthetical would assert something untrue:
 *
 * - No other price source has a sample to take a median over.
 * - A manual price *replaces* the trade figure, so pairing it with the leftover median would read as
 *   a range the user never set.
 * - Items priced before this existed carry no median (nothing migrates `loot-cache.json`).
 * - `count > 1` means the headline is a summed group total, and a median printed beside a sum
 *   describes nothing. Trade2 only ever prices Rares and `groupItems` refuses to fold anything
 *   carrying mods, so this is a guard rather than a live case — but it is also what makes comparing
 *   the two numbers valid at all, since an unfolded row's `total` is one item at `stackSize` 1.
 * - The two agreeing (a one-listing sample) makes `12ex (12ex)`, which is noise.
 */
function medianValueEl(item: PricedItem, count: number, total: number | null): HTMLElement | null {
  const median = item.tradeMedianChaosValue;
  if (item.priceSource !== "trade2" || item.manualChaosValue !== null) return null;
  if (median === undefined || count !== 1 || total === null || median === total) return null;

  const el = document.createElement("span");
  el.className = "item-value-median";
  // The same unit as the headline it sits beside — a floor in chaos next to a median in exalted is
  // two numbers the eye cannot compare, which is the one thing the pair exists to let it do.
  el.textContent = `(${formatValue(median, rowQuote(item, count))})`;
  el.title =
    "Median of the listings this price was sampled from. The headline is the cheapest one " +
    "currently listed — the wider the gap, the thinner that floor.";
  return el;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/*
 * These three take `ParsedItem`, not `PricedItem` — they read nothing a price adds, and the wider
 * type is what lets a pending row reuse them verbatim. `PricedItem extends ParsedItem`, so every
 * existing caller is unaffected.
 */
function itemNameEl(item: ParsedItem, count?: number): HTMLElement {
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
function itemSubtitle(item: ParsedItem): HTMLElement | null {
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

/**
 * An item's mod lines with their kinds — the renderer's copy of `modsOf()` in shared/mods.ts.
 *
 * Duplicated rather than imported for the reason at the top of this file. It's needed because the
 * flattened `implicitMods`/`explicitMods` arrays throw the kind away, and the row editor labels each
 * mod with it. The fallback matters as much as the main path: `mods` postdates `loot-cache.json` and
 * nothing migrates it, so an older item has only the arrays.
 */
function itemMods(item: PricedItem): ParsedMod[] {
  if (item.mods && item.mods.length > 0) return item.mods;
  return [
    ...(item.implicitMods ?? []).map((text): ParsedMod => ({ text, kind: "implicit" })),
    ...(item.explicitMods ?? []).map((text): ParsedMod => ({ text, kind: "explicit" }))
  ];
}

/**
 * The mod's roll split out of its text, or null for a mod that carries no number.
 *
 * The first number is taken deliberately: `compileTemplate` in trade-stats.ts turns GGG's `#`
 * placeholders into `\+?(-?[0-9.]+)` and reads capture group 1, so for an ordinary single-`#` stat
 * this is the same number the search filters on. It's an approximation of that, not a reimplementation
 * — the matcher and its stat reference live in the main process — so a line whose first number isn't
 * the template's `#` will show a bound the old search didn't use. That is on screen and editable,
 * which is the point of showing it at all.
 *
 * A null return is what suppresses the bounds inputs, and it lands on roughly the stats GGG indexes
 * with no `#` at all ("Cannot be Frozen") — those are matched on presence and a bound would be a lie.
 */
function splitModRoll(text: string): { before: string; roll: string; after: string } | null {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match || match.index === undefined) return null;
  return {
    before: text.slice(0, match.index),
    roll: match[0],
    after: text.slice(match.index + match[0].length)
  };
}

interface ItemGroup {
  item: PricedItem;
  count: number;
  total: number | null;
}

/**
 * Identical stackable drops are folded into one row. Five separate Exalted Orb pickups are five
 * lines of noise; what the user wants to know is how many dropped in this map.
 *
 * **The group carries its newest member, not its first.** `item` is what every consumer reads the
 * row's timestamp off — `minimalGroups()` sorts the heads-up form by it, `visibleGroups()` sorts by
 * it under sort=time, and the row prints it as "Ns ago". Keeping the first meant a repeat pickup
 * folded into a group still dated from the *original* drop, so re-picking up a currency you already
 * had left the heads-up showing some other, older item as the last drop, and parked the row at its
 * first pickup's place in the time sort. `count` and `total` were right throughout, which is what
 * made it read as a display fault rather than a pricing one.
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
      // Compared rather than just taking the last one seen: `allItems` happens to be in capture
      // order today, but nothing here should quietly depend on that holding.
      if (item.capturedAt > existing.item.capturedAt) existing.item = item;
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
