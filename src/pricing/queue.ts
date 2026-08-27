import { randomUUID } from "node:crypto";
import type { ParsedItem, PendingCapture, PendingStage, PricedItem } from "../shared/types";
import type { PriceResolver } from "./price-resolver";

const THROTTLE_MS = 250;

interface QueueEntry {
  id: string;
  item: ParsedItem;
  stage: PendingStage;
  /**
   * Abandons this entry's lookup, and only this entry's.
   *
   * Per-entry rather than one handle on the queue, because it is what the resolver is handed: a
   * cancel addressed to the entry cannot touch a Reprice the row editor is running beside it, which
   * the fetch-level `cancelInFlight` below cannot promise — both ride the one trade2 fetch instance.
   * It also reaches the waits between requests, where nothing is in flight at all.
   */
  abort: AbortController;
}

/** FIFO queue so rapid hotkey presses don't fire concurrent, unthrottled pricing requests. */
export class PricingQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  /**
   * The entry being resolved. Held apart from `queue` because it has already been shifted off, and
   * it is the one the user is actually waiting on — so it leads the pushed list.
   */
  private current: QueueEntry | null = null;
  /**
   * The entry `cancelCurrent()` was called on, held only until that entry finishes.
   *
   * An id rather than a boolean because the answer it decides — whether a thrown resolver was a
   * fault or a decision — has to be about *this* entry. A flag would still be set when the next
   * item threw for reasons of its own, and would label a genuine break as something the user did.
   */
  private cancellingId: string | null = null;

  constructor(
    private readonly resolver: PriceResolver,
    private readonly onPriced: (item: Omit<PricedItem, "id">) => void,
    /**
     * Everything captured but not yet priced, pushed whole on every transition.
     *
     * Optional and last: without it the queue behaves exactly as it did before, which is what keeps
     * the existing two-argument constructions working.
     */
    private readonly onPending?: (pending: PendingCapture[]) => void,
    /**
     * Calls off whatever network wait the resolver is currently in — `CancellableGggFetch`'s
     * `cancelInFlight` in the real app, absent in tests that never reach the network.
     *
     * Injected rather than reached for, so the queue stays the one place that decides an entry was
     * cancelled: without it `cancelCurrent()` still marks the entry, it just has nothing to
     * interrupt and the lookup finishes on its own.
     */
    private readonly cancelInFlight?: () => void
  ) {}

  /**
   * Abandon the lookup in flight, so the queue can move on to the next capture.
   *
   * **The current entry only.** The backlog behind it is still worth pricing, and dropping it too
   * would make one stuck item cost every drop captured while it was stuck — which is the situation
   * this exists to get out of, not one to widen.
   *
   * Answers whether there was anything to cancel. A press with the queue idle is a no-op: nothing
   * is marked, so the next lookup to start is unaffected.
   */
  cancelCurrent(): boolean {
    if (!this.current) return false;
    this.cancellingId = this.current.id;
    // Both, and in this order. The signal is what interrupts a wait — most of a rare's wall clock is
    // `spendBudgetSlot()` spacing searches out, and a press during one used to report success while
    // the ladder carried on and priced the item anyway. `cancelInFlight` stays because the resolver
    // also reaches poe.ninja and the currency exchange, which the signal is not threaded into.
    this.current.abort.abort(new Error("the lookup was cancelled from the overlay"));
    this.cancelInFlight?.();
    return true;
  }

  enqueue(item: ParsedItem): void {
    this.queue.push({ id: randomUUID(), item, stage: "queued", abort: new AbortController() });
    this.emitPending();
    void this.drain();
  }

  /** The in-flight entry first, then the backlog in the order it will be worked through. */
  private emitPending(): void {
    if (!this.onPending) return;
    const entries = this.current ? [this.current, ...this.queue] : this.queue;
    this.onPending(entries.map(({ id, item, stage }) => ({ id, item, stage })));
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.current = entry;
      entry.stage = "pricing";
      this.emitPending();

      let priced: Omit<PricedItem, "id">;
      try {
        priced = await this.resolver.resolve(
          entry.item,
          () => {
            entry.stage = "trade2";
            this.emitPending();
          },
          entry.abort.signal
        );
      } catch (error) {
        // A cancel arrives here as a thrown abort, and it is the one throw that isn't a fault: the
        // user decided this lookup wasn't worth the wait. Recording it as `searchFailed` would send
        // them looking for a break that doesn't exist, so the two are told apart by whether *this*
        // entry is the one Stop was pressed on.
        const cancelled = this.cancellingId === entry.id;
        if (cancelled) {
          console.log(`[pricing] "${entry.item.name}" cancelled by the user, storing as unpriced`);
        } else {
          console.error("[pricing] failed to resolve item, storing as unpriced:", error);
        }
        // Swallowing the item here lost the drop entirely — no feed row, no history entry, no
        // hint that anything happened. Record it unpriced instead so it can be repriced or valued
        // by hand later.
        priced = {
          ...entry.item,
          chaosValue: null,
          priceSource: "unpriced",
          // A crashed resolver used to be stored bare, which reads on the row as "the market has
          // nothing matching this item" — the one thing it definitely does not mean. The error text
          // is the only record of what actually broke, since nothing else here survives the catch.
          unpricedReason: cancelled ? "cancelled" : "searchFailed",
          unpricedDetail: cancelled
            ? "Stop was pressed while this lookup was still running."
            : `pricing this item threw before it finished: ${
                error instanceof Error ? error.message : String(error)
              }`,
          ignoredMods: [],
          manualChaosValue: null
        };
      }

      // Retired before the priced row is announced, so the item is never on screen twice. This sits
      // outside the try/catch on purpose: a thrown resolver still has to clear the pending row, or
      // it stays up forever describing work that already stopped.
      this.current = null;
      // Cleared whichever way the entry ended, including the case where Stop landed too late to
      // interrupt anything and the item priced normally. Left set, it would label the *next*
      // failure as a cancellation.
      this.cancellingId = null;
      this.emitPending();
      this.onPriced(priced);

      await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
    }

    this.processing = false;
  }
}
