// Value/format/row helpers for the renderer, loaded as a plain <script> ahead of index.js. Like
// index.ts it must not contain ANY top-level import/export statement — even a type-only
// `import type` marks the file as an ES module to tsc, which then emits `exports` boilerplate that
// throws in a non-module <script> context. So everything here is a plain global, and shared types
// come from the `declare global` block in global.d.ts. Both files therefore share one global scope
// as far as tsc is concerned: a top-level name declared in both is a compile error, not a clash.
//
// The helpers below are therefore duplicated from shared/ rather than imported:
//   formatNumber/formatValue   <- shared/format-value.ts
//   convertFromChaos/pickDisplayUnit/formatHubRates <- shared/format-value.ts
//   itemMods                   <- shared/mods.ts  (modsOf)
// They must not drift, and test/renderer-parity.test.ts is what enforces that: it runs this file's
// compiled output in a node:vm and compares each one against its shared/ original over a table of
// inputs. A change here that the shared module doesn't get fails the suite.
//
// `effectiveValue`/`totalValue` below are the exception, and are NOT duplicates. They used to
// mirror shared/effective-value.ts; nothing in the main process ever needed a per-item value — the
// CSV export and every row are drawn here — so that module sat unimported and was deleted. These
// are the only implementations, and have no original to be kept in sync with.

type Rates = { chaosPerDivine: number; exaltedPerDivine: number };
type DisplayCurrency = "auto" | "exalted" | "chaos" | "divine";

/** Set from OVERLAY_STATUS on both pages; every value on screen is formatted through them. */
let rates: Rates | null = null;
let displayCurrency: DisplayCurrency = "auto";
/**
 * When a trade2 search could next go out, from OVERLAY_STATUS. Null when one could go now.
 *
 * A deadline rather than a countdown: the main process sends it once when a lookup spends the last
 * slot, and everything on screen counts down against `Date.now()` from there. Pushing the remaining
 * seconds instead would mean a full list rebuild every second — see the field's doc comment.
 */
let tradeCooldownUntil: number | null = null;

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
 * The unit a *row* is shown in.
 *
 * Only a single, unfolded, trade2-priced item follows its listing: `count > 1` means the headline is
 * a summed group total, `stackSize > 1` means it is a stack, and a manual price replaces the trade
 * figure entirely — in all three the quote no longer describes the number on screen. Those are the
 * same guards `listedAgeEl` applies, for the same reason.
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

/**
 * What each `PricedItem.unpricedReason` says on the row, and what it means.
 *
 * One bare "unpriced" covered seven situations that ask completely different things of the reader:
 * some resolve by waiting, one wants a setting changed, and the rest are final. `word` replaces the
 * badge text and the value cell; `hint` is the generic half of the tooltip, with the item's own
 * `unpricedDetail` appended under it.
 *
 * `recoverable` picks between the two existing badge colours rather than adding new ones, and it is
 * the distinction worth keeping visible above all the others — blue means nobody has looked yet and
 * the answer arrives on its own, tan means the market has been asked and this is its answer.
 *
 * "search skipped" rather than "not searched" on purpose: the row editor already badges individual
 * mod rows `not searched` for an unrelated reason, and one word meaning two things across two
 * surfaces of the same panel is what this whole table exists to stop.
 */
const UNPRICED_REASON: Record<string, { word: string; hint: string; recoverable: boolean }> = {
  rateLimited: {
    word: "rate limited",
    hint:
      "No trade search went out for this item — GGG rate-limits by IP and the budget was spent. " +
      "Press Edit and Reprice once the window refills; nothing about the item itself is wrong.",
    recoverable: true
  },
  pricesLoading: {
    word: "prices loading",
    hint:
      "poe.ninja's first refresh hadn't finished when this was captured, so there was nothing to " +
      "look it up in. Press Edit and Reprice now that prices are in.",
    recoverable: true
  },
  searchFailed: {
    word: "search failed",
    hint:
      "The trade search went out and broke rather than coming back empty. This is a fault, not a " +
      "finding about the item — press Edit and Reprice to try again.",
    recoverable: true
  },
  noListings: {
    word: "no listings",
    hint:
      "The search ran and the market has nothing matching this item. Repricing will return the " +
      "same answer; the detail below names the constraint that came up empty.",
    recoverable: false
  },
  unconvertible: {
    word: "no chaos price",
    hint:
      "Listings exist, but none of them quoted a currency this app could convert to chaos — " +
      "unpriced stash tabs, or something poe.ninja isn't tracking. Open the trade search to look.",
    recoverable: false
  },
  notSearchable: {
    word: "not searchable",
    hint:
      "There is nothing reliable to search this item on, so no lookup is possible at all. Set a " +
      "price by hand with the row's Edit button.",
    recoverable: false
  },
  notSearched: {
    word: "search skipped",
    hint:
      "No search was sent, because a setting says not to for items like this one. The detail " +
      "below names which setting to change.",
    recoverable: false
  },
  noPriceData: {
    word: "no price data",
    hint:
      "This item isn't in poe.ninja's data and isn't traded on the currency exchange, and nothing " +
      "else could price it. Set a price by hand with the row's Edit button.",
    recoverable: false
  }
};

/** The row's word for an item with no price, and the tooltip under it. See `UNPRICED_REASON`. */
function unpricedLabel(item: PricedItem): { word: string; title: string; recoverable: boolean } {
  const reason = item.unpricedReason ? UNPRICED_REASON[item.unpricedReason] : undefined;
  if (!reason) {
    // Absent, or a code written by a newer build than this renderer. Either way the honest answer is
    // the word this all started as, plus whatever detail did survive.
    return { word: "unpriced", title: item.unpricedDetail ?? "", recoverable: false };
  }
  return {
    word: reason.word,
    // Same blank-line join the partial-match titles below use.
    title: item.unpricedDetail ? `${reason.hint}\n\n${item.unpricedDetail}` : reason.hint,
    recoverable: reason.recoverable
  };
}

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
    // "unpriced" reads as a fact about the item — that nothing on the market matches it. Half of the
    // reasons mean the opposite: nobody has looked yet, and the answer arrives by waiting. Same badge
    // slot, different word, because they ask different things of the reader.
    const reason = unpricedLabel(item);
    badge.textContent = reason.word;
    badge.classList.add(reason.recoverable ? "badge-ratelimited" : "badge-unpriced");
    if (reason.title) badge.title = reason.title;
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
 * The `(listed 3d ago)` beside a trade2 price — when the cheapest listing, the one the headline *is*,
 * was posted. The same number three days stale and an hour fresh are different facts about how much
 * the floor is worth trusting, and the price alone cannot say which.
 *
 * Says "listed" rather than a bare age because the row already carries one relative time: the capture
 * time on the line below. Two unlabelled "3d ago"s on one row read as the same clock.
 *
 * Returns null in every case where the parenthetical would assert something untrue:
 *
 * - No other price source has a listing behind it to be the age of.
 * - A manual price *replaces* the trade figure, so the old listing's date annotates a number that is
 *   no longer on screen.
 * - Items priced before this existed carry no date (nothing migrates `loot-cache.json`), and so do
 *   listings whose date GGG didn't send or that wouldn't parse. Both mean "say nothing".
 * - `count > 1` means the headline is a summed group total, and one listing's date describes nothing
 *   about a sum. Trade2 only ever prices Rares and `groupItems` refuses to fold anything carrying
 *   mods, so this is a guard rather than a live case.
 * - An unpriced row has no headline for the date to qualify.
 */
function listedAgeEl(item: PricedItem, count: number, total: number | null): HTMLElement | null {
  const indexedAt = item.tradeListingIndexedAt;
  if (item.priceSource !== "trade2" || item.manualChaosValue !== null) return null;
  if (indexedAt === undefined || count !== 1 || total === null) return null;

  const el = document.createElement("span");
  el.className = "item-value-listed";
  // Read back by refreshElapsedLabels, which re-prefixes rather than reusing `.feed-time`: that
  // scanner overwrites textContent with a bare relativeTime, which would eat the word.
  el.dataset.at = String(indexedAt);
  el.textContent = `(listed ${relativeTime(indexedAt)})`;
  el.title =
    "When the cheapest listing this price came from was posted. An old listing is one nobody has " +
    "bought at that price, which is worth knowing before undercutting it.";
  return el;
}

/**
 * A coarse "how long ago", for both the row's capture time and its listing age.
 *
 * The day tier exists for listings: they are routinely days old, and `72h ago` is a number the reader
 * has to divide before it means anything. Capture times get it too — the list grows unbounded, so old
 * rows read in days as well, which is the same improvement rather than a side effect.
 */
/** How long is left on the trade2 cooldown, in ms. 0 when there is none, or it has just run out. */
function cooldownRemainingMs(): number {
  if (tradeCooldownUntil === null) return 0;
  return Math.max(0, tradeCooldownUntil - Date.now());
}

/**
 * A countdown, in the coarsest form that still reads at a glance.
 *
 * Three tiers because the range genuinely spans them: the short budget window is five minutes, but
 * `cooldownMs()` reports the longest wait across *both* windows and the long one is six hours, so a
 * heavy session can produce a real multi-hour number. A plain `mm:ss` would render that as `360:00`.
 */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return `${total}s`;

  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

/**
 * What an unpriced row prints where the number would go.
 *
 * Only `rateLimited` differs from its badge word, and it is the one reason with something live to
 * say: the cooldown is global — GGG limits by IP, so one window covers every item at once — which is
 * why this reads the current deadline rather than anything stored on the item. That is also the right
 * answer for a row rate-limited an hour ago: if the budget has refilled it says so, and if a new map
 * has spent it again then pressing Reprice really would fail, so the countdown is still this row's
 * honest answer.
 *
 * Nothing here retries anything. The row says when it is worth pressing Reprice; pressing it stays
 * the user's decision, because the budget is shared with every other rare in the map.
 */
function unpricedValueText(item: PricedItem): string {
  const label = unpricedLabel(item);
  if (item.unpricedReason !== "rateLimited") return label.word;

  const remaining = cooldownRemainingMs();
  return remaining > 0 ? `retry in ${formatCountdown(remaining)}` : "ready to reprice";
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
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
    // `unpricedReason` is part of the key because the group shows only its newest member's badge:
    // two stacks of the same currency that went unpriced for different reasons would otherwise fold
    // into one row claiming both had the newer one's reason. Undefined on everything priced, so it
    // changes no existing fold.
    const key = groupable
      ? `${item.name}|${item.priceSource}|${item.unpricedReason ?? ""}`
      : item.id;

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
