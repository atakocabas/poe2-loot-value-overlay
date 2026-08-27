import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sleep } from "../pricing/sleep";

describe("the abortable sleep", () => {
  test("resolves normally when nobody aborts it", async () => {
    await sleep(5);
  });

  test("rejects rather than resolving when the signal fires mid-wait", async () => {
    // The distinction the whole module exists for. A sleep that *resolved* on abort would hand its
    // caller the same answer a completed wait does, and the caller would fall straight through into
    // the request it was throttling — which is how a pressed Stop came to report success while the
    // lookup carried on and priced the item anyway.
    const controller = new AbortController();
    const reason = new Error("called off");
    const waiting = sleep(10_000, controller.signal);
    controller.abort(reason);

    await assert.rejects(waiting, (error) => error === reason);
  });

  test("rejects immediately on a signal that was already aborted", async () => {
    // The lost-race case: the abort landed while the caller was between two waits, so this one is
    // handed a signal that has already fired. Waiting the full duration first would make a cancel
    // depend on exactly where in the ladder it arrived.
    const controller = new AbortController();
    const reason = new Error("called off first");
    controller.abort(reason);

    await assert.rejects(sleep(10_000, controller.signal), (error) => error === reason);
  });

  test("a completed sleep leaves no listener behind on the signal", async () => {
    // These signals outlive one wait — a lookup walks up to six rungs on the same one — so a
    // listener kept per completed sleep accumulates for the length of the whole lookup.
    const controller = new AbortController();
    let listeners = 0;
    const { addEventListener, removeEventListener } = controller.signal;
    controller.signal.addEventListener = ((...args: Parameters<typeof addEventListener>) => {
      listeners += 1;
      return addEventListener.apply(controller.signal, args);
    }) as typeof addEventListener;
    controller.signal.removeEventListener = ((
      ...args: Parameters<typeof removeEventListener>
    ) => {
      listeners -= 1;
      return removeEventListener.apply(controller.signal, args);
    }) as typeof removeEventListener;

    await sleep(1, controller.signal);

    assert.equal(listeners, 0);
  });
});
