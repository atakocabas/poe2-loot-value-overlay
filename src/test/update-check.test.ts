import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UpdateChecker, type AvailableUpdate } from "../main/update-check";
import type { Settings } from "../shared/settings";

function makeSettings(checkForUpdates = true): Settings {
  return {
    updates: { checkForUpdates, checkIntervalMs: 21600000 }
  } as unknown as Settings;
}

/** A stand-in for `fetch` that answers with one canned GitHub release body and counts its calls. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: unknown, options: unknown) => {
    const request = (options ?? {}) as { headers?: Record<string, string> };
    calls.push({ url: String(url), headers: request.headers ?? {} });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function collect(): { updates: AvailableUpdate[]; onUpdate: (update: AvailableUpdate) => void } {
  const updates: AvailableUpdate[] = [];
  return { updates, onUpdate: (update) => updates.push(update) };
}

describe("UpdateChecker", () => {
  test("reports a newer release with the tag's v stripped", async () => {
    const { impl } = stubFetch({ tag_name: "v0.3.0", html_url: "https://example.invalid/releases/v0.3.0" });
    const sink = collect();
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: sink.onUpdate
    });

    await checker.check();

    assert.deepEqual(sink.updates, [{ version: "0.3.0", url: "https://example.invalid/releases/v0.3.0" }]);
    assert.deepEqual(checker.getAvailable(), { version: "0.3.0", url: "https://example.invalid/releases/v0.3.0" });
  });

  test("says nothing when the latest release is the one running", async () => {
    const { impl } = stubFetch({ tag_name: "v0.2.0", html_url: "https://example.invalid/r" });
    const sink = collect();
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: sink.onUpdate
    });

    await checker.check();

    assert.deepEqual(sink.updates, []);
    assert.equal(checker.getAvailable(), null);
  });

  test("says nothing when the running version is ahead of the latest release", async () => {
    const { impl } = stubFetch({ tag_name: "v0.2.0", html_url: "https://example.invalid/r" });
    const sink = collect();
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.3.0",
      fetchImpl: impl,
      onUpdate: sink.onUpdate
    });

    await checker.check();

    assert.deepEqual(sink.updates, []);
  });

  // The six-hourly tick keeps finding the same release; both surfaces already hold it.
  test("reports one release only once", async () => {
    const { impl } = stubFetch({ tag_name: "v0.3.0", html_url: "https://example.invalid/r" });
    const sink = collect();
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: sink.onUpdate
    });

    await checker.check();
    await checker.check();
    await checker.check();

    assert.equal(sink.updates.length, 1);
  });

  test("identifies itself, since GitHub rejects a request with no User-Agent", async () => {
    const { impl, calls } = stubFetch({ tag_name: "v0.2.0", html_url: "https://example.invalid/r" });
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: () => {}
    });

    await checker.check();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers["User-Agent"], "PoE2LootValueOverlay/0.2.0");
    // No contact address: `appUserAgent()` appends one for GGG's policy, and GitHub never asked.
    assert.ok(!calls[0].headers["User-Agent"].includes("contact"));
  });

  // Offline, captive portal, spent rate limit — all ordinary, and all of them reach the boot chain's
  // `.catch`, which would report the whole app as having failed to start.
  test("a thrown fetch is swallowed", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    }) as unknown as typeof fetch;
    const sink = collect();
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: sink.onUpdate
    });

    await checker.check();

    assert.deepEqual(sink.updates, []);
    assert.equal(checker.getAvailable(), null);
  });

  test("a non-OK response reports nothing", async () => {
    const { impl } = stubFetch({}, { ok: false, status: 403 });
    const sink = collect();
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: sink.onUpdate
    });

    await checker.check();

    assert.deepEqual(sink.updates, []);
  });

  test("a release with no tag or url reports nothing", async () => {
    const { impl } = stubFetch({ name: "0.3.0" });
    const sink = collect();
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: sink.onUpdate
    });

    await checker.check();

    assert.deepEqual(sink.updates, []);
  });

  test("start() makes no request when the check is switched off", () => {
    const { impl, calls } = stubFetch({ tag_name: "v9.9.9", html_url: "https://example.invalid/r" });
    const checker = new UpdateChecker({
      settings: makeSettings(false),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: () => {}
    });

    checker.start();
    checker.stop();

    assert.deepEqual(calls, []);
  });

  test("concurrent checks share one request", async () => {
    const { impl, calls } = stubFetch({ tag_name: "v0.3.0", html_url: "https://example.invalid/r" });
    const checker = new UpdateChecker({
      settings: makeSettings(),
      currentVersion: "0.2.0",
      fetchImpl: impl,
      onUpdate: () => {}
    });

    await Promise.all([checker.check(), checker.check(), checker.check()]);

    assert.equal(calls.length, 1);
  });
});
