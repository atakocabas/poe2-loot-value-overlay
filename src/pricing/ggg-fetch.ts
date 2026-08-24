import type { Settings } from "../shared/settings";
import { GggRateLimiter } from "./rate-limiter";
import packageJson from "../../package.json";

export type GggFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * How long a single GGG request may hang before it is abandoned.
 *
 * `fetch` has no timeout of its own, so before this a dead socket blocked the serial
 * `PricingQueue` forever: the pending row stayed on "pricing", every later capture queued behind
 * it, and nothing short of restarting the app got it back. 30s is well past the slowest healthy
 * trade2 search observed (a full ladder runs in a few seconds) and well short of a player noticing
 * a stall and reaching for the Stop button.
 *
 * It covers the request only. The rate limiter's waits are excluded on purpose and the signal is
 * built after them — a lockout wait is minutes to an hour by design, and timing it out would put
 * the request straight into the ban threshold `GggRateLimiter` exists to keep it out of.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A `GggFetch` whose current request can be called off from outside.
 *
 * Cancellation lives here rather than being threaded as an `AbortSignal` through `PriceResolver`,
 * `Trade2Client` and `TradeStatsMatcher` because every one of those would have grown a parameter it
 * otherwise has no use for, and `estimateRareValue` already carries six. The queue is serial, so
 * "the request in flight" is unambiguous — and the one caller that cancels is the one that owns
 * the queue.
 */
export interface CancellableGggFetch {
  fetch: GggFetch;
  /**
   * Aborts the request or rate-limit wait in flight right now, if there is one. A no-op otherwise,
   * so pressing Stop on an idle queue does nothing rather than poisoning the next lookup.
   */
  cancelInFlight(): void;
}

/**
 * Wraps fetch with the identification and rate-limit self-throttling GGG's API Policies doc
 * requires for any request to their hosts. Shared by trade2-client.ts, trade-stats.ts and
 * currency-exchange-client.ts so all three stay compliant without duplicating this.
 *
 * Every endpoint this app *prices* against is public and unauthenticated, so the User-Agent is a
 * plain `AppName/version (contact: ...)`. The policy's `OAuth {clientId}/{version} (contact: ...)`
 * format is specifically for *authorized* API clients holding a registered client id; this app holds
 * none, and an earlier version of this file emitted a malformed `OAuth /1.0.0 (...)` with the id left
 * empty. A plain agent is both correct and still satisfies the policy's "identify yourself" rule.
 *
 * The contact clause is dropped entirely when no email is configured, for the same reason: a
 * dangling `(contact: )` is a malformed header that identifies nobody. The address belongs to
 * whoever is running this install and is asked for in the setup window, so it is legitimately
 * absent until they supply one — the app name and version still identify the client.
 *
 * The rate limiter matters most for `pathofexile.com/api/trade2/*`, which limits by IP and hands
 * out multi-minute lockouts; it no-ops harmlessly on hosts that send no `X-Rate-Limit-*` headers.
 * It is reactive by nature — see `TradeSearchBudget` for the proactive half.
 */
/**
 * `AppName/version (contact: someone@example.com)`, with the contact clause dropped when no address
 * is configured — see above for why both halves are shaped this way.
 *
 * Exported because `PoeNinjaClient` wants the same identification without the rest of this module:
 * poe.ninja is not a GGG host, sends no `X-Rate-Limit-*` headers for the limiter to act on, and is
 * under no GGG policy — but "say who you are" is worth doing for a free community API regardless,
 * and two hand-maintained copies of this string would drift.
 */
export function appUserAgent(settings: Settings): string {
  // Optional-chained rather than assumed present: an absent trade2 block is the same situation as a
  // blank address — nobody to name — and the app is still identified either way. `PoeNinjaClient`
  // has no other reason to depend on that block, so it must not fail to construct without one.
  const contact = settings.trade2?.contactEmail?.trim();
  return `PoE2LootValueOverlay/${packageJson.version}${contact ? ` (contact: ${contact})` : ""}`;
}

export function createPublicGggFetch(settings: Settings): GggFetch {
  return createCancellableGggFetch(settings).fetch;
}

/**
 * The same fetch, plus the handle that calls off whatever it is currently waiting on.
 *
 * Each client that wants to be cancellable independently needs its own instance — the limiter
 * state and the in-flight handle are both per-instance, so cancelling the trade2 one cannot
 * disturb a currency-exchange refresh that happens to be running beside it.
 */
export function createCancellableGggFetch(settings: Settings): CancellableGggFetch {
  return createThrottledFetch(appUserAgent(settings));
}

function createThrottledFetch(userAgent: string): CancellableGggFetch {
  const rateLimiter = new GggRateLimiter();
  let inFlight: AbortController | null = null;

  const throttled: GggFetch = async (url, init = {}) => {
    const controller = new AbortController();
    inFlight = controller;

    try {
      // Cancellable but not timed out: see REQUEST_TIMEOUT_MS. This is also why the timeout signal
      // is constructed below rather than up here — it starts counting the moment it exists, so a
      // legitimate half-hour lockout wait would hand an already-expired signal to the request.
      await rateLimiter.waitIfNeeded(controller.signal);

      // The caller's own signal is combined rather than overridden. Nothing passes one today, but
      // `...init` used to carry it through to fetch, and silently dropping it here would be the
      // kind of regression that only shows up as a request that won't die.
      const signals = [controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
      if (init.signal) signals.push(init.signal);

      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any(signals),
        headers: { ...init.headers, "User-Agent": userAgent }
      });

      rateLimiter.recordHeaders(response.headers);
      if (response.status === 429) {
        await rateLimiter.handle429(response, controller.signal);
      }
      return response;
    } finally {
      // Guarded rather than nulled outright: a second request starting before this one's finally
      // runs owns the handle now, and clearing it blind would leave that one uncancellable.
      if (inFlight === controller) inFlight = null;
    }
  };

  return {
    fetch: throttled,
    cancelInFlight: () => inFlight?.abort()
  };
}
