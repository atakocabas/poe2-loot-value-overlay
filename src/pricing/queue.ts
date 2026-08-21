import { randomUUID } from "node:crypto";
import type { ParsedItem, PendingCapture, PendingStage, PricedItem } from "../shared/types";
import type { PriceResolver } from "./price-resolver";

const THROTTLE_MS = 250;

interface QueueEntry {
  id: string;
  item: ParsedItem;
  stage: PendingStage;
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

  constructor(
    private readonly resolver: PriceResolver,
    private readonly onPriced: (item: Omit<PricedItem, "id">) => void,
    /**
     * Everything captured but not yet priced, pushed whole on every transition.
     *
     * Optional and last: without it the queue behaves exactly as it did before, which is what keeps
     * the existing two-argument constructions working.
     */
    private readonly onPending?: (pending: PendingCapture[]) => void
  ) {}

  enqueue(item: ParsedItem): void {
    this.queue.push({ id: randomUUID(), item, stage: "queued" });
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
        priced = await this.resolver.resolve(entry.item, () => {
          entry.stage = "trade2";
          this.emitPending();
        });
      } catch (error) {
        // Swallowing the item here lost the drop entirely — no feed row, no history entry, no
        // hint that anything happened. Record it unpriced instead so it can be repriced or valued
        // by hand later.
        console.error("[pricing] failed to resolve item, storing as unpriced:", error);
        priced = {
          ...entry.item,
          chaosValue: null,
          priceSource: "unpriced",
          // A crashed resolver used to be stored bare, which reads on the row as "the market has
          // nothing matching this item" — the one thing it definitely does not mean. The error text
          // is the only record of what actually broke, since nothing else here survives the catch.
          unpricedReason: "searchFailed",
          unpricedDetail: `pricing this item threw before it finished: ${
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
      this.emitPending();
      this.onPriced(priced);

      await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
    }

    this.processing = false;
  }
}
