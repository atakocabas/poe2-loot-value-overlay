import type { Settings } from "../shared/settings";
import { GggRateLimiter } from "./rate-limiter";
import packageJson from "../../package.json";

export type GggFetch = (url: string, init?: RequestInit) => Promise<Response>;

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
 * The one exception is the stash read — see `createAuthenticatedGggFetch` below, which is a sibling of
 * `createPublicGggFetch` rather than a flag on it precisely so that no pricing call can ever acquire a
 * credential by accident.
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
  return createThrottledFetch(appUserAgent(settings));
}

/**
 * The credentialed sibling, used by `StashClient` and by nothing else. Reading a player's own stash
 * has no unauthenticated route at all — GGG serves it only behind the OAuth API, whose client
 * registration is closed — so this carries the user's own `POESESSID` as a cookie.
 *
 * Three things about it are deliberate:
 *
 * - **It is a separate factory, not an option on `createPublicGggFetch`.** Every pricing client is
 *   constructed from that one, and a flag there would be one mistaken argument away from attaching a
 *   session cookie to every trade2 search — which would change what GGG's per-IP rate limiting is
 *   counting and hand a credential to endpoints that never asked for one.
 * - **It gets its own `GggRateLimiter`.** The stash endpoint is a different rate-limit bucket from
 *   trade search and advertises its own policy headers, so a shared limiter would have each endpoint's
 *   ceiling overwrite the other's. It is also deliberately outside `TradeSearchBudget`: that budget is
 *   the proactive half for trade *search* specifically, while a stash read is user-initiated,
 *   infrequent, and correctly governed by the reactive limiter alone.
 * - **`sessionId` is a getter, not a value.** A credential saved in the stash window has to reach the
 *   very next read without reconstructing the client — the same live-apply test `SettingsConfig`
 *   applies to the settings window. An absent credential sends no `Cookie` header at all rather than
 *   an empty one, so the request fails as unauthenticated instead of as malformed.
 */
export function createAuthenticatedGggFetch(
  settings: Settings,
  sessionId: () => string | null
): GggFetch {
  return createThrottledFetch(appUserAgent(settings), (): Record<string, string> => {
    const id = sessionId();
    return id ? { Cookie: `POESESSID=${id}` } : {};
  });
}

function createThrottledFetch(
  userAgent: string,
  extraHeaders?: () => Record<string, string>
): GggFetch {
  const rateLimiter = new GggRateLimiter();

  return async (url, init = {}) => {
    await rateLimiter.waitIfNeeded();

    const response = await fetch(url, {
      ...init,
      headers: { ...init.headers, "User-Agent": userAgent, ...(extraHeaders?.() ?? {}) }
    });

    rateLimiter.recordHeaders(response.headers);
    if (response.status === 429) {
      await rateLimiter.handle429(response);
    }
    return response;
  };
}
