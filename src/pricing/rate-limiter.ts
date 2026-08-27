import { sleep } from "./sleep";

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
