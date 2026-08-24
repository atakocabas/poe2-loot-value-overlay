import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GggRateLimiter } from "../pricing/rate-limiter";

/**
 * A response's rate-limit headers as GGG sends them: `max:periodSec:restrictSec` for the rule, and
 * `current:periodSec:restrictedSec` for the state. A non-zero third field on the *state* is the
 * lockout — the app is barred for that many seconds.
 */
function headers(limit: string, state: string): Headers {
  return new Headers({
    "x-rate-limit-policy": "trade-search-request-limit",
    "x-rate-limit-rules": "Ip",
    "x-rate-limit-Ip": limit,
    "x-rate-limit-Ip-state": state
  });
}

test("a limiter that has seen no headers never waits", async () => {
  // Every host that isn't pathofexile.com, and the first request to one that is.
  await new GggRateLimiter().waitIfNeeded();
});

describe("abandoning a wait", () => {
  test("an in-progress lockout wait rejects when the signal aborts", async () => {
    const limiter = new GggRateLimiter();
    // 1800s of lockout: the real penalty for overrunning GGG's 5-minute bucket, and long enough that
    // the test would never finish if the abort didn't take.
    limiter.recordHeaders(headers("8:300:1800", "8:300:1800"));

    const controller = new AbortController();
    const waiting = limiter.waitIfNeeded(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));

    controller.abort();

    // Rejects rather than resolving early, and the distinction is the whole point: resolving would
    // fall straight through into the request this wait exists to hold back.
    await assert.rejects(waiting);
  });

  test("a signal already aborted refuses before it starts sleeping", async () => {
    const limiter = new GggRateLimiter();
    limiter.recordHeaders(headers("8:300:1800", "8:300:1800"));

    await assert.rejects(limiter.waitIfNeeded(AbortSignal.abort()));
  });

  test("an un-aborted wait still resolves, and still waits", async () => {
    const limiter = new GggRateLimiter();
    // At the ceiling with no lockout: spreads requests over periodSec/max — 0.05s here, short enough
    // to actually serve out in a test.
    limiter.recordHeaders(headers("20:1:60", "20:1:0"));

    const started = Date.now();
    await limiter.waitIfNeeded(new AbortController().signal);

    assert.ok(
      Date.now() - started >= 40,
      "the throttle has to be real — a signal must not turn the wait off"
    );
  });

  test("no signal at all behaves as it always did", async () => {
    const limiter = new GggRateLimiter();
    limiter.recordHeaders(headers("20:1:60", "20:1:0"));

    // The two other callers of this class pass nothing, and must keep working untouched.
    await limiter.waitIfNeeded();
  });

  test("handle429 is abandonable too", async () => {
    const limiter = new GggRateLimiter();
    const controller = new AbortController();
    const response = new Response("", { status: 429, headers: { "retry-after": "1800" } });

    const waiting = limiter.handle429(response, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await assert.rejects(waiting);
  });
});

test("a state below the ceiling with no lockout does not wait at all", async () => {
  const limiter = new GggRateLimiter();
  limiter.recordHeaders(headers("8:300:1800", "1:300:0"));

  const started = Date.now();
  await limiter.waitIfNeeded();
  assert.ok(Date.now() - started < 40, "one request into a bucket of eight must not be throttled");
});
