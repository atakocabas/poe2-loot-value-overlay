import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createCancellableGggFetch } from "../pricing/ggg-fetch";
import type { Settings } from "../shared/settings";

/** Only the field `appUserAgent` reads; the rest of `Settings` is irrelevant to this module. */
function makeSettings(contactEmail = ""): Settings {
  return { trade2: { contactEmail } } as unknown as Settings;
}

/**
 * Swaps in a stub `fetch` for the duration of `run`, since `createThrottledFetch` closes over the
 * global one. Restored in a `finally` so a failing assertion can't leak the stub into the next file —
 * these run in one process.
 */
async function withStubFetch(
  stub: (url: string, init: RequestInit) => Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = stub as typeof globalThis.fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

describe("cancelling a request in flight", () => {
  test("cancelInFlight aborts the signal the request is holding", async () => {
    let captured: AbortSignal | null = null;
    let release: ((response: Response) => void) | null = null;

    await withStubFetch(
      (_url, init) => {
        captured = init.signal as AbortSignal;
        // Never settles on its own: this is the hang the Stop button exists for.
        return new Promise<Response>((resolve, reject) => {
          release = resolve;
          captured!.addEventListener("abort", () => reject(captured!.reason), { once: true });
        });
      },
      async () => {
        const { fetch, cancelInFlight } = createCancellableGggFetch(makeSettings());
        const pending = fetch("https://www.pathofexile.com/api/trade2/search/Standard");
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.ok(captured, "the request must reach fetch with a signal on it");
        assert.equal(captured!.aborted, false, "nothing has been cancelled yet");

        cancelInFlight();

        assert.equal(captured!.aborted, true, "Stop has to reach the request, not just the queue");
        await assert.rejects(pending, "an abandoned lookup must reject rather than hang on");
        assert.equal(release !== null, true);
      }
    );
  });

  test("cancelling with nothing in flight is a no-op, not a poisoned next request", async () => {
    let captured: AbortSignal | null = null;

    await withStubFetch(
      (_url, init) => {
        captured = init.signal as AbortSignal;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      async () => {
        const { fetch, cancelInFlight } = createCancellableGggFetch(makeSettings());

        // The press an idle queue gets. Before the handle was cleared in a `finally`, a stale
        // controller here would have carried the abort into the lookup that started next.
        cancelInFlight();
        cancelInFlight();

        const response = await fetch("https://www.pathofexile.com/api/trade2/data/stats");
        assert.equal(response.status, 200);
        assert.equal(captured!.aborted, false, "the next request must start clean");
      }
    );
  });

  test("a finished request releases the handle, so a later press cannot reach it", async () => {
    const signals: AbortSignal[] = [];

    await withStubFetch(
      (_url, init) => {
        signals.push(init.signal as AbortSignal);
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
      async () => {
        const { fetch, cancelInFlight } = createCancellableGggFetch(makeSettings());

        await fetch("https://www.pathofexile.com/api/trade2/data/stats");
        cancelInFlight();

        assert.equal(signals.length, 1);
        assert.equal(
          signals[0]!.aborted,
          false,
          "a request that already answered must not be retroactively cancelled"
        );
      }
    );
  });

  test("the caller's own signal is combined with ours rather than replaced", async () => {
    let captured: AbortSignal | null = null;

    await withStubFetch(
      (_url, init) => {
        captured = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          captured!.addEventListener("abort", () => reject(captured!.reason), { once: true });
        });
      },
      async () => {
        const { fetch } = createCancellableGggFetch(makeSettings());
        const caller = new AbortController();
        const pending = fetch("https://www.pathofexile.com/api/trade2/data/stats", {
          signal: caller.signal
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        // `...init` used to carry a caller's signal straight through to fetch. Overriding it with
        // ours would silently drop it, which shows up only as a request that won't die.
        caller.abort();
        await assert.rejects(pending);
        assert.equal(captured!.aborted, true);
      }
    );
  });
});

test("the user agent identifies the app, and drops the contact clause when blank", async () => {
  const seen: string[] = [];

  await withStubFetch(
    (_url, init) => {
      seen.push(String((init.headers as Record<string, string>)["User-Agent"]));
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
    async () => {
      await createCancellableGggFetch(makeSettings("someone@example.com")).fetch("https://x/");
      await createCancellableGggFetch(makeSettings("   ")).fetch("https://x/");
    }
  );

  assert.match(seen[0]!, /^PoE2LootValueOverlay\/\d+\.\d+\.\d+ \(contact: someone@example\.com\)$/);
  // A dangling "(contact: )" is a malformed header that identifies nobody — see the note in the module.
  assert.match(seen[1]!, /^PoE2LootValueOverlay\/\d+\.\d+\.\d+$/);
});
