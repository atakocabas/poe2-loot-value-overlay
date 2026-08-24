interface SubLimit {
  max: number;
  periodSec: number;
  restrictSec: number;
}

interface SubLimitState {
  current: number;
  periodSec: number;
  restrictedSec: number;
}

function parseTriples(header: string): [number, number, number][] {
  return header.split(",").map((part) => {
    const [a, b, c] = part.trim().split(":").map(Number);
    return [a, b, c];
  });
}

/**
 * A sleep the caller can cut short.
 *
 * The waits below are deliberately long — `restrictedSec` on a tripped bucket is 30 minutes for
 * the 5-minute rule and an hour for the 6-hour one — and until this took a signal there was no way
 * to stop serving one out. That is most of what "the app is stuck querying" actually was: not a
 * hung socket but a lockout being waited out correctly, with nothing on screen saying so and no way
 * to abandon the item and move on.
 *
 * Rejects with the signal's reason rather than resolving early, so an abandoned wait can never be
 * mistaken for a wait that finished and fall through into the request it was throttling.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Named rather than inline so the resolve path above can remove it: these listeners outlive a
    // completed sleep otherwise, and one accumulates per request on a long-lived signal.
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Tracks GGG's X-Rate-Limit-* response headers (see the API Policies doc) so calls to
 * pathofexile.com self-throttle instead of risking the "Invalid Requests Threshold" ban that
 * follows repeated 429s.
 */
export class GggRateLimiter {
  private rules: string[] = [];
  private limits = new Map<string, SubLimit[]>();
  private states = new Map<string, SubLimitState[]>();

  recordHeaders(headers: Headers): void {
    const policy = headers.get("x-rate-limit-policy");
    const rulesHeader = headers.get("x-rate-limit-rules");
    if (!policy || !rulesHeader) return;

    this.rules = rulesHeader.split(",").map((rule) => rule.trim());

    for (const rule of this.rules) {
      const limitHeader = headers.get(`x-rate-limit-${rule}`);
      const stateHeader = headers.get(`x-rate-limit-${rule}-state`);

      if (limitHeader) {
        this.limits.set(
          rule,
          parseTriples(limitHeader).map(([max, periodSec, restrictSec]) => ({ max, periodSec, restrictSec }))
        );
      }
      if (stateHeader) {
        this.states.set(
          rule,
          parseTriples(stateHeader).map(([current, periodSec, restrictedSec]) => ({ current, periodSec, restrictedSec }))
        );
      }
    }
  }

  /**
   * Call before every request. Sleeps if the last observed state is at/near a tracked limit.
   *
   * `signal` abandons the wait — see `sleep` above for why that matters. It is deliberately *not*
   * the same signal as the request timeout: a lockout wait of half an hour is this class working,
   * not hanging, and timing it out would send the request straight into the ban threshold the whole
   * class exists to avoid.
   */
  async waitIfNeeded(signal?: AbortSignal): Promise<void> {
    for (const rule of this.rules) {
      const limits = this.limits.get(rule) ?? [];
      const states = this.states.get(rule) ?? [];

      for (let i = 0; i < limits.length; i++) {
        const limit = limits[i];
        const state = states[i];
        if (!state) continue;

        if (state.restrictedSec > 0) {
          await sleep(state.restrictedSec * 1000, signal);
        } else if (state.current >= limit.max) {
          // Already at the ceiling for this window — spread requests across the period
          // instead of bursting right up against the limit again.
          await sleep((limit.periodSec / limit.max) * 1000, signal);
        }
      }
    }
  }

  /** Call on a 429 instead of retrying immediately. Abandonable for the same reason as above. */
  async handle429(response: Response, signal?: AbortSignal): Promise<void> {
    const retryAfterSec = Number(response.headers.get("retry-after") ?? "5");
    await sleep(Math.max(retryAfterSec, 1) * 1000, signal);
  }
}
