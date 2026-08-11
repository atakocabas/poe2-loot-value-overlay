/**
 * Proactive spend limiter for GGG trade searches.
 *
 * The trade API rate-limits by **IP**, and tightly: a live response advertises
 * `X-Rate-Limit-Ip: 5:10:60,15:60:300,30:300:1800,600:21600:3600` — 5 requests per 10s, 15 per
 * minute, 30 per 5 minutes, 600 per 6 hours, each with its own multi-minute lockout for exceeding
 * it (the 5-minute bucket locks you out for 30). One price lookup costs two requests (search, then
 * fetch), so ~15 lookups per five minutes is the ceiling before anything else in the app can talk
 * to pathofexile.com either.
 *
 * `GggRateLimiter` is not sufficient on its own here for two reasons. It is *reactive* — it can
 * only throttle once a response has told it how close to the ceiling we are, which is too late for
 * the very first burst — and it throttles by **sleeping**. Sleeping is wrong for this caller:
 * `PricingQueue` is serial, so a map's worth of rare drops would block it for minutes and stall the
 * poe.ninja-priceable currency queued behind them.
 *
 * So once the window budget is spent this **declines** instead of waiting. The extra rares are
 * stored unpriced with a reason naming the cooldown, and the row's Reprice button picks
 * them up at human pace. Short intra-window spacing is still enforced by waiting, since that is
 * bounded by `minIntervalMs` rather than by the whole window.
 */
export class TradeSearchBudget {
  /** Timestamps (epoch ms) at which reserved searches are/were issued. Ascending. */
  private readonly issueTimes: number[] = [];

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly minIntervalMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Claims a slot for one search. Returns how long the caller must wait before issuing it (0 means
   * now), or null when the window budget is spent and the search should be abandoned.
   *
   * Reserving and recording are one operation on purpose: the pricing queue and the row editor's
   * Reprice button can both be in flight, and a separate check-then-record would let them each pass
   * the check and then both spend the last slot.
   */
  reserve(): number | null {
    const now = this.now();
    while (this.issueTimes.length > 0 && now - this.issueTimes[0] >= this.windowMs) {
      this.issueTimes.shift();
    }
    if (this.issueTimes.length >= this.maxPerWindow) return null;

    // Spacing is measured from the previously *reserved* issue time, not from now, so two calls
    // arriving in the same tick get staggered rather than both firing immediately.
    const previous = this.issueTimes[this.issueTimes.length - 1];
    const issueAt = previous === undefined ? now : Math.max(now, previous + this.minIntervalMs);
    this.issueTimes.push(issueAt);
    return issueAt - now;
  }

  /**
   * How long until a spent budget frees up a slot, for the "retry in ~Ns" message. 0 when there is
   * budget available right now.
   */
  cooldownMs(): number {
    if (this.issueTimes.length < this.maxPerWindow) return 0;
    return Math.max(0, this.windowMs - (this.now() - this.issueTimes[0]));
  }
}
