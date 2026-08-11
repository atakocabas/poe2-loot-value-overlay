import type { ParsedItem, PricedItem } from "../shared/types";
import type { PriceResolver } from "./price-resolver";

const THROTTLE_MS = 250;

/** FIFO queue so rapid hotkey presses don't fire concurrent, unthrottled pricing requests. */
export class PricingQueue {
  private queue: ParsedItem[] = [];
  private processing = false;

  constructor(
    private readonly resolver: PriceResolver,
    private readonly getSessionId: () => string,
    private readonly onPriced: (item: Omit<PricedItem, "id">) => void
  ) {}

  enqueue(item: ParsedItem): void {
    this.queue.push(item);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        const priced = await this.resolver.resolve(item, this.getSessionId());
        this.onPriced(priced);
      } catch (error) {
        // Swallowing the item here lost the drop entirely — no feed row, no history entry, no
        // hint that anything happened. Record it unpriced instead so it can be repriced or valued
        // by hand later.
        console.error("[pricing] failed to resolve item, storing as unpriced:", error);
        this.onPriced({
          ...item,
          sessionId: this.getSessionId(),
          chaosValue: null,
          priceSource: "unpriced",
          ignoredMods: [],
          manualChaosValue: null
        });
      }
      await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));
    }

    this.processing = false;
  }
}
