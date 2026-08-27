# Price sources: the resolver, poe.ninja, the currency exchange and the queue

Steps 3 and 4 of the data flow — `src/pricing/price-resolver.ts`, `poeninja-client.ts`,
`currency-exchange-client.ts`, `exchange-metadata-ids.ts`, `currency-convert.ts` and `queue.ts`. For
trade2 search itself see `docs/pricing-trade2.md`.

Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---

3. `PriceResolver` (`src/pricing/price-resolver.ts`) tries `PoeNinjaClient` by item name first,
   then `CurrencyExchangeClient`, then falls back to `Trade2Client` (mod-aware search) for unpriced
   **Rares** — otherwise the item is stored with `priceSource: "unpriced"` and a logged reason.

   **The automatic path persists everything the estimate carries**, the same set `REPRICE_ITEM`
   writes. It used to keep six fields and drop `statCoverage`, `coverageSample`, `pseudoDropped` and
   `mapDropped` even though the search had already paid for them, so a freshly captured rare showed
   none of the badges the row is built to render until the user pressed Reprice once — which read as
   missing data rather than a lost write. `autoDroppedMods` is what made that asymmetry
   load-bearing: without it the row editor cannot show which mods produced an *automatic* price, and
   showing that is the reason the field exists. `searchedMods` is now the same argument again, and
   the more visible one — it is what the editor's checkboxes read, so dropping it here would leave an
   automatically priced rare ticking every mod while a repriced one ticked only what it searched.
   Keep the two write paths in step.

   The resolver does **not** gate the trade2 call on availability or rate-limit budget; it calls
   unconditionally for Rares and `Trade2Client` short-circuits internally. That keeps one place
   deciding whether a lookup happens and one place wording the refusal, which is then reused
   verbatim by the unpriced log line and by the row editor's Reprice status text.

   The exchange is consulted when poe.ninja *misses* **or** when poe.ninja's data is older than
   `currencyExchange.stalePoeNinjaAfterMs` — the staleness arm is what covers poe.ninja being down,
   since a cached value would otherwise be served indefinitely with nothing to signal it. If the
   exchange also has nothing, a stale poe.ninja value is still preferred over no price at all.

   poe.ninja's exchange feed publishes only slug ids and no id->name metadata, so the lookup is
   inverted: `slugify()` rebuilds the id from the item name. Two things about that are measured, not
   assumed. Accents are **folded** (`Oisín's Oath` -> `oisins-oath`); without it `í` fell outside
   `[a-z0-9]`, became a separator, and produced `ois-ns-oath`, which matched nothing and left a real
   item unpriced. But poe.ninja is **not consistent** about this in its own ids — the same category
   ships `oisins-oath` *and* `mórrigans-insight` — so `slugVariants()` offers both spellings and
   `lookupCandidates()` probes each. Don't collapse it back to one.

   **poe.ninja is not a GGG host and gets none of `ggg-fetch.ts`.** It publishes no rate limits and
   returns no `X-Rate-Limit-*` headers, so `GggRateLimiter` would have nothing to act on — there is
   nothing to measure and nothing to react to, which argues for restraint rather than against it.
   Three things stand in for it, none optional:
   - **One pool across both category lists** (`inPool`, `poeNinja.maxConcurrentRequests`, default 4).
     A refresh is 23 requests and firing them together at a free community service behind Cloudflare
     is the pattern that gets an IP blocked. It must stay **one** pool: two under a `Promise.all`
     each honour the limit while the refresh runs at twice it — measured at 8 in flight for a
     configured 4. A bad value falls back to the default rather than reducing the limit to `NaN`,
     which emptied the batch and made a refresh silently fetch nothing.
   - **An identifying `User-Agent`**, via `appUserAgent()` shared with `createPublicGggFetch` so the
     string can't drift. It optional-chains `trade2.contactEmail`, since `PoeNinjaClient` otherwise
     has no reason to require that block.
   - **One refresh at a time** — `refresh()` hands every caller the promise already in flight rather
     than starting a second pull. Each concurrent call would open its *own* pool, so two overlapping
     refreshes run at twice the configured concurrency: the same failure the single pool guards
     against, by another route. It only became reachable when the panel grew its **Refresh prices**
     button (`REFRESH_PRICES`), whose press can land on the 10-minute timer's tick or on a previous
     press — and it is what gives that button its "already refreshing" behaviour for nothing. The
     handler reports success as `getLastRefreshAt()` having *moved*, reusing the existing rule that
     only a pull which actually returned prices counts, so "the request finished" and "there are new
     prices" stay distinguishable. A failure is reported in the button's own label, like the Clear
     button's confirm step: this window is frameless and non-focusable, so a native dialog can end up
     behind the game.
4. `PricingQueue` (`src/pricing/queue.ts`) throttles resolution to one item per 250ms and persists
   the result via `db/store.ts`, then pushes it to the renderer over IPC.

   It also **owns the pending list** — everything captured but not yet priced — and pushes it whole
   on `PRICING_STATUS` at every transition, because until this existed the renderer had no idea an
   item existed until it was fully priced. That gap is long and silent: most of a rare's wall clock
   is `spendBudgetSlot()`'s `await sleep()` inside `TradeSearchBudget` spacing, which logs nothing
   and can run five times at `minSearchIntervalMs`. That sleep is **abortable** (`pricing/sleep.ts`)
   and it did not used to be, which is what made Stop a lie for most of a lookup's duration — see
   the cancel rules below. The stage comes from two places — the
   queue itself for `queued`/`pricing`, and the optional `onTradeSearch` callback on
   `PriceResolver.resolve()` for `trade2`, fired at the one point the work stops being a cache
   lookup. Retiring an entry happens **before** `onPriced`, so an item is never on screen twice, and
   it sits outside the try/catch: a thrown resolver that skipped it would leave a row up forever.

   **`cancelCurrent()` abandons the entry in flight, and only that one.** The panel's Stop button
   reaches it over `CANCEL_PRICING`. Three rules:
   - **The backlog is left alone on purpose.** Stop exists because one stuck lookup blocks a serial
     queue; dropping everything captured behind it would make that jam cost more, not less. If the
     next entry is already being looked up when the push lands, the button simply re-enables.
   - **The queue marks the cancelled entry by *id*, not with a flag**, and clears it however the
     entry ends. That id is what decides whether the resolver's throw was a fault or a decision — a
     boolean would still be set when the *next* item failed on its own, and would report a genuine
     break as something the user did.
   - **A cancel is stored as `unpricedReason: "cancelled"`, never `searchFailed`.** Nothing broke.
     The row says "stopped" and is marked recoverable, which is what points at Reprice.

   **The interrupt is two things, and it needs both.** Each entry carries its own `AbortController`,
   whose signal is passed to `PriceResolver.resolve()` and threaded down through `estimateRareValue`;
   `cancelInFlight` is injected on top of it, as before.
   - The **signal** is what reaches the *waits*. Before it existed, cancellation was addressed only
     to whatever request the fetch had in `inFlight` — and during `spendBudgetSlot()`'s spacing there
     is nothing in flight at all. The abort was a no-op, the sleep ran to completion, the next rung
     got a fresh un-aborted controller, and **the button said "Stopped" while the item priced
     normally**. Since that is where most of the wall clock goes, this was the common case.
   - It is also **per entry**, so a Stop cannot abort a lookup it was not aimed at. The row editor's
     Reprice runs on the same `trade2Fetch` instance, which is why the fetch-level handle alone
     cannot promise that.
   - **`cancelInFlight` stays** rather than being replaced: `resolve()` also reaches poe.ninja and the
     currency exchange, which the signal is not threaded into. Without it the queue still marks the
     entry, it just has less to interrupt — which is exactly what the two-argument constructions in
     the tests do.
   - `Trade2Client.attempt()` **rethrows an abort instead of reporting it transient.** Laundered into
     a transient failure it would go round the caller's retry loop and spend another budget slot
     re-asking the question the user just called off.

   **A cancelled search still spends its budget slot.** `TradeSearchBudget.reserve()` has no release
   path and should not grow one: it is called before the request goes out, GGG's per-IP counter
   counted anything that actually left, and a refund would make cancel-spam a way to blow the real
   limit. See [pricing-trade2.md](pricing-trade2.md).

**`CurrencyExchangeClient`** (`src/pricing/currency-exchange-client.ts`) reads GGG's public,
unauthenticated PoE2 Currency Exchange feed. Three things about it are measured behaviour, not
guesses — don't "simplify" them away:
- **The feed publishes an integer ratio pair normalized so the quote side is 1**, so the price of
  `a` in `b` is `ratio[b] / ratio[a]`. The direction is easy to invert silently; the guard is that
  derived chaos-per-divine must stay near poe.ninja's (`npm run verify:exchange-ids`).
- **The hour's low and high are collapsed with a geometric mean**, because a thin market can span
  6..28 per divine within one hour and the arithmetic mean sits far above any real trade.
- **Chaos is not the exchange's hub — exalted is**, ahead of divine, with chaos third. Items are
  therefore priced against whichever hub they trade with and converted, and the hub rates come from
  the exchange itself so the fallback doesn't depend on poe.ninja to interpret its own numbers.

`src/pricing/exchange-metadata-ids.ts` maps display names to the feed's internal metadata ids. This
**cannot** be derived from poe.ninja: its `image` field encodes an *art asset* path
(`2DItems/Currency/CurrencyVaal`) that often differs from the item's metadata id (`CurrencyCorrupt`),
agreeing for only ~2% of traded ids. Deriving it by price agreement doesn't work either — hundreds
of items sit within 10% of one another. Add entries by hand and confirm them with
`npm run verify:exchange-ids`, which prices each mapped id off the live feed and compares it against
poe.ninja. That check flags only errors that are *both* relatively and absolutely large: sub-exalted
items routinely disagree 2-3x between the two sources without either being wrong.

---

## Non-goals / do not "fix"

- `CurrencyExchangeClient` covering only currency-exchange-traded items, and therefore never pricing
  rares, is inherent to the data source. It is a fallback for poe.ninja, not a replacement for
  trade search.
- Partial coverage in `exchange-metadata-ids.ts` is deliberate: an unmapped name returns null and
  the item falls through to unpriced, whereas a wrong entry silently reports a different item's
  price. Omit ids you cannot verify.
