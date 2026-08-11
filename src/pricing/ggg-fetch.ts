import type { Settings } from "../shared/settings";
import { GggRateLimiter } from "./rate-limiter";
import packageJson from "../../package.json";

export type GggFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Wraps fetch with the identification and rate-limit self-throttling GGG's API Policies doc
 * requires for any request to their hosts. Shared by trade2-client.ts, trade-stats.ts and
 * currency-exchange-client.ts so all three stay compliant without duplicating this.
 *
 * Every endpoint this app touches is public and unauthenticated, so the User-Agent is a plain
 * `AppName/version (contact: ...)`. The policy's `OAuth {clientId}/{version} (contact: ...)` format
 * is specifically for *authorized* API clients holding a registered client id; this app holds none,
 * and an earlier version of this file emitted a malformed `OAuth /1.0.0 (...)` with the id left
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
export function createPublicGggFetch(settings: Settings): GggFetch {
  const contact = settings.trade2.contactEmail.trim();
  return createThrottledFetch(
    `PoE2LootValueOverlay/${packageJson.version}${contact ? ` (contact: ${contact})` : ""}`
  );
}

function createThrottledFetch(userAgent: string): GggFetch {
  const rateLimiter = new GggRateLimiter();

  return async (url, init = {}) => {
    await rateLimiter.waitIfNeeded();

    const response = await fetch(url, {
      ...init,
      headers: { ...init.headers, "User-Agent": userAgent }
    });

    rateLimiter.recordHeaders(response.headers);
    if (response.status === 429) {
      await rateLimiter.handle429(response);
    }
    return response;
  };
}
