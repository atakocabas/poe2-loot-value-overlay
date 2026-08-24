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
    tooltipEl.replaceChildren(renderItemText(item.rawText));
    tooltipEl.classList.remove("hidden");
    positionTooltip(el);
  });
  el.addEventListener("mouseleave", () => tooltipEl.classList.add("hidden"));
}

/** The line PoE2 puts between the blocks of an item's text. */
const ITEM_TEXT_SEPARATOR = "--------";

/**
 * The clipboard text as classified lines rather than one flat block.
 *
 * It used to be assigned with `textContent`, which meant a rare's twenty-odd lines arrived as one
 * grey wall at 11px: the `--------` rules were as loud as the mods, and the Advanced Item
 * Description affix headers — metadata about a mod, not the mod — were louder still, since they are
 * the longest lines on the item. Splitting it lets the stylesheet put the rolls in front and the
 * scaffolding behind, which is the whole of what makes it readable at a glance mid-map.
 *
 * Every line still appears verbatim and in order. This classifies, it never rewrites — the tooltip
 * is the only place the raw capture can be read, and a line quietly reworded here would be a lie
 * about what the parser was handed.
 */
function renderItemText(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = text.split("\n");
  // The parser's own header gate. Only when both hold is line three actually the item's name;
  // anything else is text this app didn't capture and shouldn't pretend to understand.
  const hasHeader =
    lines[0]?.startsWith("Item Class:") === true && lines[1]?.startsWith("Rarity:") === true;

  for (const [index, line] of lines.entries()) {
    const el = document.createElement("div");
    if (line.trim() === ITEM_TEXT_SEPARATOR) {
      // Drawn as a rule rather than kept as eight dashes: as text it reads like content.
      el.className = "tip-sep";
    } else {
      el.textContent = line;
      el.className = itemTextLineClass(line, index, hasHeader);
    }
    fragment.append(el);
  }
  return fragment;
}

/** Which part of an item's text a line belongs to, for the colours in style.css. */
function itemTextLineClass(line: string, index: number, hasHeader: boolean): string {
  if (hasHeader && index < 2) return "tip-meta";
  if (hasHeader && index === 2) return "tip-name";
  if (hasHeader && index === 3) return "tip-base";
  // `{ Prefix Modifier "Banshee's" (Tier: 1) — Evasion }`. Advanced Item Descriptions puts each
  // affix's own metadata on a line above its rolls; it is context for the mod, not a mod.
  if (line.startsWith("{") && line.endsWith("}")) return "tip-affix";
  // `Quality: +20%`, `Item Level: 81`, `Requires: Level 75` — the game's property block.
  if (/^[A-Za-z][A-Za-z ]*: /.test(line)) return "tip-prop";
  return "tip-mod";
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
  },
  cancelled: {
    word: "stopped",
    hint:
      "You pressed Stop while this was being looked up, so the search was abandoned. Nothing is " +
      "wrong with the item — press Edit and Reprice to try it again.",
    recoverable: true
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
 * How long a cheapest listing has to have sat before the market is called dead, in ms.
 *
 * The cheapest listing is the most attractive offer on the board. If *it* has not cleared in a month,
 * nothing priced above it has either, so there is nothing left for the rest of the sample to say and
 * no range worth quoting — which is why this is a short-circuit in `suggestSellRange` rather than one
 * more input to the weighting below.
 *
 * Measured against the stored cache when this was written, the cheapest listing was older than 7d on
 * 44% of dated rows, 14d on 41% and 30d on 30%. Thirty days is the conservative end of that: it
 * catches only the definitely-dead, and can be tightened once the verdict has been used in anger.
 */
const SELL_DEAD_MARKET_MS = 30 * 24 * 3600_000;
/**
 * How fast a listing's evidential weight halves, in hours.
 *
 * A listing that has sat unsold is evidence *against* its own asking price clearing, and the longer
 * it has sat the weaker that price is as a guide. One day is roughly the point at which a listing on
 * an actively traded item stops being news.
 */
const SELL_HALF_LIFE_H = 24;
/**
 * The weight given to a listing GGG sent no usable date for.
 *
 * Deliberately middling rather than 1: an undated listing is not a fresh one, and treating it as one
 * is how a sample of unknowns would quietly produce a confident-looking range.
 */
const SELL_UNKNOWN_DATE_WEIGHT = 0.35;
/** The weight below which a listing stops counting as live — about two days at the half-life above. */
const SELL_FRESH_ENOUGH = 0.25;
/**
 * How far below its own sample's median a listing may sit before it is treated as an outlier rather
 * than a price — a price-fixer, a mislist, or a stash tab priced by accident.
 *
 * A **ratio**, not an absolute floor, because the stored rows span 0.03 to 3853 chaos and any fixed
 * cutoff is meaningless at one end of that. Measured over those rows, the cheapest listing sat below a
 * sixth of its own median often enough to matter, with a worst case of 364x.
 */
const SELL_LOW_OUTLIER_RATIO = 6;
/** How many listings a trim has to leave behind before it is allowed to happen at all. */
const SELL_MIN_AFTER_TRIM = 3;

/**
 * What the sampled listings support as an asking price, or why they support nothing.
 *
 * `dead` and `stale` are verdicts, not failures: on the stored rows they are the majority outcome,
 * and saying so is the point of this. A row whose only comparable has sat untouched for two months
 * does not have a cheap price, it has no market, and quoting the dead listing back as a suggestion
 * would be the one genuinely misleading thing this could do.
 */
type SellSuggestion =
  | { kind: "dead"; ageMs: number }
  | { kind: "stale"; ageMs: number }
  | { kind: "range"; low: number; high: number; used: number; trimmed: number }
  | { kind: "single"; value: number; used: number; flat: boolean }
  | { kind: "needsReprice" };

/**
 * What to ask for the item, from the listings its price was sampled over and how long each has sat.
 *
 * **What the sample is matters for reading this.** It is the cheapest 5-10 of up to 100
 * price-ascending matches: the market's left tail, not its distribution. So this can never answer
 * "what is it worth" — only "given the cheap end I am competing against, and how long each of those
 * has been sitting there, where do I list". Every label built from it has to say so.
 *
 * Ages are measured against `now`, not against when the price was fetched. That is deliberate, and it
 * is what makes a months-old row read as stale: a listing that was fresh when we saw it, sixty days
 * ago, says nothing about today, and the honest output there is "reprice" rather than a range
 * reconstructed from a snapshot that has since expired. It is also why no fetch time is stored.
 *
 * Returns null in the same cases `listedAgeEl` does — a suggestion, like the age beside the price, is
 * an annotation on one listing's number, and is a lie about anything else.
 */
function suggestSellRange(
  item: PricedItem,
  count: number,
  now: number = Date.now()
): SellSuggestion | null {
  // A manual price replaces the trade figure, so the listings behind it describe a number no longer
  // on screen; no other source has listings at all; a group total or a stack is a sum, and one
  // listing's price is not a fact about a sum.
  if (item.priceSource !== "trade2" || item.manualChaosValue !== null) return null;
  if (count !== 1 || item.stackSize !== 1) return null;
  if (effectiveValue(item) === null) return null;

  const indexedAt = item.tradeListingIndexedAt;
  // Items priced before the date was stored, and listings GGG sent no parseable date for, both mean
  // "say nothing" — the whole verdict below rests on ages, and there is no age here to rest it on.
  if (indexedAt === undefined) return null;

  // The dominance gate, and it runs before anything reads the sample: a fresh listing priced above a
  // month-old cheapest one is not evidence of a live market, it is evidence of a more expensive
  // listing that has also not sold.
  const cheapestAge = now - indexedAt;
  if (cheapestAge > SELL_DEAD_MARKET_MS) return { kind: "dead", ageMs: cheapestAge };

  const sample = item.tradeListingSample;
  // Every row stored before the sample was retained still reaches the gate above, which is most of
  // what the verdict is worth; a range needs the listings the gate does not.
  if (sample === undefined || sample.length === 0) return { kind: "needsReprice" };

  const weighed = sample
    .map((listing) => ({
      chaos: listing.chaos,
      weight:
        listing.indexedAt === undefined
          ? SELL_UNKNOWN_DATE_WEIGHT
          : Math.pow(0.5, (now - listing.indexedAt) / 3600_000 / SELL_HALF_LIFE_H)
    }))
    .sort((a, b) => a.chaos - b.chaos);

  // Trimmed against the untrimmed median, so the outliers being removed cannot drag the threshold
  // down to meet themselves. Only allowed to happen while it leaves a sample worth reasoning over —
  // on three listings the "outlier" may simply be the market.
  const median = weighed[Math.floor((weighed.length - 1) / 2)]!.chaos;
  const floor = median / SELL_LOW_OUTLIER_RATIO;
  const survivors = weighed.filter((entry) => entry.chaos >= floor);
  const kept = survivors.length >= SELL_MIN_AFTER_TRIM ? survivors : weighed;

  const live = kept.filter((entry) => entry.weight >= SELL_FRESH_ENOUGH);
  // Inside the gate but with nothing live in it: the softer sibling of the dead verdict, covering the
  // rows whose cheapest listing is days rather than months old.
  if (live.length === 0) return { kind: "stale", ageMs: cheapestAge };

  const flat = kept.every((entry) => entry.chaos === kept[0]!.chaos);
  // Undercut this and you are the cheapest listing anyone is actually looking at.
  const low = live[0]!.chaos;
  // Above the weighted middle of the cheap end you have left the pack this sample can speak for.
  const high = Math.max(low, weightedMedianChaos(kept));

  if (flat) return { kind: "single", value: low, used: kept.length, flat: true };
  if (high === low) return { kind: "single", value: low, used: kept.length, flat: false };
  return { kind: "range", low, high, used: kept.length, trimmed: weighed.length - kept.length };
}

/**
 * How long something lasted, in the tiers `relativeTime` uses — "72d", "5h".
 *
 * Separate from `relativeTime` because that one measures against `Date.now()` and suffixes "ago",
 * which is right for a timestamp on a row and wrong inside a sentence: "nothing has moved here in
 * 72d ago" is what reusing it produces. This takes the elapsed span itself, so the caller decides
 * what it is a span between.
 */
function describeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(0, seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/** The chaos figure half the sample's freshness weight sits below. Input must be sorted by price. */
function weightedMedianChaos(sorted: Array<{ chaos: number; weight: number }>): number {
  const half = sorted.reduce((sum, entry) => sum + entry.weight, 0) / 2;
  let running = 0;
  for (const entry of sorted) {
    running += entry.weight;
    if (running >= half) return entry.chaos;
  }
  return sorted[sorted.length - 1]!.chaos;
}

/**
 * Both ends of a range in one unit.
 *
 * `formatValue` picks a unit per value from its magnitude, so a range straddling a boundary prints as
 * "10c - 1.26div": two units on one line, which the reader has to convert before the span means
 * anything. The unit is chosen once, from the high end, and both ends are printed in it.
 *
 * The quote is threaded through for the same reason it is on the row — the suggestion sits directly
 * under the headline, and the two reading in different units would look like a discrepancy rather
 * than a choice.
 */
function formatRange(low: number, high: number, quote?: ListingQuote | null): string {
  if (!rates || !Number.isFinite(rates.chaosPerDivine) || rates.chaosPerDivine <= 0) {
    return `${formatNumber(low)}c - ${formatNumber(high)}c`;
  }
  const unit = pickDisplayUnit(high, rates, quote);
  const label = UNIT_LABEL[unit];
  return (
    `${formatNumber(convertFromChaos(low, rates, unit))}${label} - ` +
    `${formatNumber(convertFromChaos(high, rates, unit))}${label}`
  );
}

/**
 * The verdict as the editor prints it: a headline, the reasoning under it, and whether it reads as a
 * warning rather than as a number.
 *
 * Kept apart from `suggestSellRange` so the arithmetic can be tested without a DOM, and so the wording
 * lives in one place — the same separation `unpricedLabel` has from the badge that prints it.
 */
function sellSuggestionText(
  suggestion: SellSuggestion,
  quote?: ListingQuote | null
): { text: string; title: string; warn: boolean } {
  switch (suggestion.kind) {
    case "dead":
      return {
        text: `No sell price — nothing has moved here in ${describeDuration(suggestion.ageMs)}`,
        title:
          "The cheapest listing on the market is this old and still has not sold. It is the most " +
          "attractive offer anyone can see, so nothing priced above it has sold either, and there is " +
          "no asking price that would move this item today. Reprice to see whether that has changed.",
        warn: true
      };
    case "stale":
      return {
        text: `No sell price — the cheapest listing is ${describeDuration(suggestion.ageMs)} old and unsold`,
        title:
          "Every listing this price was sampled over has sat long enough that none of them is " +
          "evidence of what the item clears at. Undercutting a listing nobody bought only makes you " +
          "the cheapest listing nobody buys.",
        warn: true
      };
    case "range":
      return {
        text: `Ask ${formatRange(suggestion.low, suggestion.high, quote)}`,
        title:
          `From ${suggestion.used} sampled listing(s), weighted by how long each has gone unsold` +
          (suggestion.trimmed > 0
            ? `, discarding ${suggestion.trimmed} priced far under the rest of the sample`
            : "") +
          ".\n\nThe low end undercuts the cheapest listing that is still live. The high end is the " +
          "middle of the cheap listings this search sampled — above it you have left the group the " +
          "price was measured over, which is the cheapest handful of matches rather than the market.",
        warn: false
      };
    case "single":
      return {
        text: `Ask ${formatValue(suggestion.value, quote)}`,
        title: suggestion.flat
          ? `All ${suggestion.used} sampled listing(s) are asking this. A flat cheap end is the ` +
            "strongest read this can give: there is a settled price and it is this one."
          : "Only one sampled listing is recent enough to price against, so this is a single " +
            "observation rather than a range. Treat it as a starting point.",
        warn: false
      };
    case "needsReprice":
      return {
        text: "Reprice for a suggested sell price",
        title:
          "This item was priced before the listings behind a price were kept, so only the cheapest " +
          "one survives. Repricing samples the market again and records enough to suggest a range.",
        warn: false
      };
  }
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
