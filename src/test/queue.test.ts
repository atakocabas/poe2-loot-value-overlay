import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PricingQueue } from "../pricing/queue";
import type { PriceResolver } from "../pricing/price-resolver";
import type { ParsedItem, PendingCapture, PricedItem } from "../shared/types";

function makeItem(name: string): ParsedItem {
  return {
    rawText: `Rarity: Currency\n${name}`,
    rarity: "Currency",
    name,
    baseType: name,
    itemClass: "Stackable Currency",
    stackSize: 1,
    itemLevel: null,
    quality: null,
    gemLevel: null,
    waystoneTier: null,
    socketCount: null,
    defences: { armour: null, evasion: null, energyShield: null, ward: null },
    weapon: { elementalDamage: null, attacksPerSecond: null },
    mapStats: {
      itemRarity: null,
      packSize: null,
      monsterRarity: null,
      dropChance: null,
      monsterEffectiveness: null,
      revives: null
    },
    identified: true,
    corrupted: false,
    mods: [],
    implicitMods: [],
    explicitMods: [],
    capturedAt: Date.now()
  };
}

test("an item whose resolution throws is still recorded, as unpriced", async () => {
  const priced: Array<Omit<PricedItem, "id">> = [];
  const resolver = {
    resolve: async () => {
      throw new Error("poe.ninja unreachable");
    }
  } as unknown as PriceResolver;

  const queue = new PricingQueue(resolver, (item) => priced.push(item));
  queue.enqueue(makeItem("Divine Orb"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(priced.length, 1, "a failed resolution must not silently drop the drop");
  assert.equal(priced[0].name, "Divine Orb");
  assert.equal(priced[0].chaosValue, null);
  assert.equal(priced[0].priceSource, "unpriced");
  // A crash and an empty market are the two things that must never read the same on the row: one is
  // a fault worth seeing, the other is the market's answer. The thrown message is the only record of
  // what actually broke, since nothing else survives the catch.
  assert.equal(priced[0].unpricedReason, "searchFailed");
  assert.match(priced[0].unpricedDetail!, /poe\.ninja unreachable/);
});

test("a failure does not stall the items queued behind it", async () => {
  const priced: Array<Omit<PricedItem, "id">> = [];
  let calls = 0;
  const resolver = {
    resolve: async (item: ParsedItem) => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { ...item, chaosValue: 5, priceSource: "poeninja", ignoredMods: [], manualChaosValue: null };
    }
  } as unknown as PriceResolver;

  const queue = new PricingQueue(resolver, (item) => priced.push(item));
  queue.enqueue(makeItem("Divine Orb"));
  queue.enqueue(makeItem("Chaos Orb"));
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.deepEqual(
    priced.map((p) => [p.name, p.priceSource]),
    [
      ["Divine Orb", "unpriced"],
      ["Chaos Orb", "poeninja"]
    ]
  );
});

describe("pending captures", () => {
  /** Each pushed snapshot as `[name, stage]` pairs, which is all the assertions below care about. */
  function stagesOf(pushes: PendingCapture[][]): Array<Array<[string, string]>> {
    return pushes.map((pending) => pending.map((p): [string, string] => [p.item.name, p.stage]));
  }

  function priceable(): PriceResolver {
    return {
      resolve: async (item: ParsedItem) => ({
        ...item,
        chaosValue: 5,
        priceSource: "poeninja",
        ignoredMods: [],
        manualChaosValue: null
      })
    } as unknown as PriceResolver;
  }

  test("an item is announced as queued the moment it is enqueued", () => {
    const pushes: PendingCapture[][] = [];
    const queue = new PricingQueue(priceable(), () => {}, (p) => pushes.push(p));

    queue.enqueue(makeItem("Doom Grip"));

    // Synchronously, before any await — the whole point is that the panel reacts to the keypress.
    assert.deepEqual(stagesOf(pushes)[0], [["Doom Grip", "queued"]]);
  });

  test("the in-flight item leads the list, with the backlog behind it in order", async () => {
    const pushes: PendingCapture[][] = [];
    let release: (() => void) | null = null;
    const resolver = {
      resolve: async (item: ParsedItem) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          ...item, chaosValue: 5, priceSource: "poeninja",
          ignoredMods: [], manualChaosValue: null
        };
      }
    } as unknown as PriceResolver;

    const queue = new PricingQueue(resolver, () => {}, (p) => pushes.push(p));
    queue.enqueue(makeItem("Doom Grip"));
    queue.enqueue(makeItem("Chaos Orb"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(stagesOf(pushes).at(-1), [
      ["Doom Grip", "pricing"],
      ["Chaos Orb", "queued"]
    ]);

    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The finished item is gone before its priced row is announced, so it is never on screen twice.
    assert.deepEqual(stagesOf(pushes).at(-1), [["Chaos Orb", "queued"]]);
  });

  test("the stage becomes trade2 when the resolver says the search has started", async () => {
    const pushes: PendingCapture[][] = [];
    const resolver = {
      resolve: async (item: ParsedItem, onTradeSearch?: () => void) => {
        onTradeSearch?.();
        return {
          ...item, chaosValue: 5, priceSource: "trade2",
          ignoredMods: [], manualChaosValue: null
        };
      }
    } as unknown as PriceResolver;

    const queue = new PricingQueue(resolver, () => {}, (p) => pushes.push(p));
    queue.enqueue(makeItem("Doom Grip"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(stagesOf(pushes), [
      [["Doom Grip", "queued"]],
      [["Doom Grip", "pricing"]],
      [["Doom Grip", "trade2"]],
      []
    ]);
  });

  test("a thrown resolver still clears the pending row", async () => {
    const pushes: PendingCapture[][] = [];
    const resolver = {
      resolve: async () => {
        throw new Error("poe.ninja unreachable");
      }
    } as unknown as PriceResolver;

    const queue = new PricingQueue(resolver, () => {}, (p) => pushes.push(p));
    queue.enqueue(makeItem("Doom Grip"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Without this the row stays up forever, describing work that stopped.
    assert.deepEqual(pushes.at(-1), []);
  });

  test("every pending id is distinct, so the rows can't collide as DOM keys", async () => {
    const pushes: PendingCapture[][] = [];
    const queue = new PricingQueue(priceable(), () => {}, (p) => pushes.push(p));

    queue.enqueue(makeItem("Doom Grip"));
    queue.enqueue(makeItem("Doom Grip"));

    const ids = pushes.at(-1)!.map((p) => p.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1], "two copies of one item must still be two rows");
  });

  test("constructing without the callback still prices normally", async () => {
    const priced: Array<Omit<PricedItem, "id">> = [];
    const queue = new PricingQueue(priceable(), (item) => priced.push(item));

    queue.enqueue(makeItem("Chaos Orb"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(priced.length, 1);
  });
});

describe("cancelling the lookup in flight", () => {
  /** Resolves immediately, for the cases where nothing is meant to be waiting. */
  function priceableResolver(): PriceResolver {
    return {
      resolve: async (item: ParsedItem) => ({
        ...item,
        chaosValue: 5,
        priceSource: "poeninja",
        ignoredMods: [],
        manualChaosValue: null
      })
    } as unknown as PriceResolver;
  }

  /**
   * A resolver that hangs until the injected `cancelInFlight` fires, which is what the real one does:
   * the abort lands on the fetch or the rate-limit wait deep inside it and surfaces here as a throw.
   */
  function hangingResolver(): { resolver: PriceResolver; abort: () => void } {
    let reject: ((error: Error) => void) | null = null;
    const resolver = {
      resolve: () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        })
    } as unknown as PriceResolver;

    return {
      resolver,
      abort: () => reject?.(new DOMException("This operation was aborted", "AbortError"))
    };
  }

  test("cancelling an idle queue says there was nothing to cancel", () => {
    const queue = new PricingQueue(priceableResolver(), () => {});

    // The press that lands just after a lookup finished. It must not mark anything, or the next
    // item to fail on its own would be reported as something the user did.
    assert.equal(queue.cancelCurrent(), false);
  });

  test("a cancelled item is recorded as stopped rather than as a failure", async () => {
    const priced: Array<Omit<PricedItem, "id">> = [];
    const { resolver, abort } = hangingResolver();

    const queue = new PricingQueue(resolver, (item) => priced.push(item), undefined, abort);
    queue.enqueue(makeItem("Doom Grip"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(queue.cancelCurrent(), true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(priced.length, 1, "a cancelled drop is still a drop and must be kept");
    assert.equal(priced[0].priceSource, "unpriced");
    // The distinction this exists for: "search failed" sends the user hunting a fault, when what
    // happened is a lookup they themselves called off.
    assert.equal(priced[0].unpricedReason, "cancelled");
    assert.match(priced[0].unpricedDetail!, /Stop was pressed/);
  });

  test("a cancel during a wait lands, with no request in flight to abort", async () => {
    // The regression this guards. Most of a rare's wall clock is `spendBudgetSlot()` spacing searches
    // `minSearchIntervalMs` apart, and during those there is nothing on the wire for the injected
    // `cancelInFlight` to abort — so Stop used to report success, the sleep ran to completion, and
    // the item priced normally anyway. The per-entry signal is what reaches the wait, so this
    // resolver ignores `cancelInFlight` entirely and listens only to the signal it was handed.
    const priced: Array<Omit<PricedItem, "id">> = [];
    const resolver = {
      resolve: (_item: ParsedItem, _onTradeSearch?: () => void, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    } as unknown as PriceResolver;

    let cancelInFlightCalls = 0;
    const queue = new PricingQueue(
      resolver,
      (item) => priced.push(item),
      undefined,
      () => {
        cancelInFlightCalls += 1;
      }
    );
    queue.enqueue(makeItem("Sekhema's Resolve"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(queue.cancelCurrent(), true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(priced.length, 1, "the entry must retire rather than hanging on the wait");
    assert.equal(priced[0].unpricedReason, "cancelled");
    // Still called: the resolver also reaches poe.ninja and the currency exchange, which the signal
    // is not threaded into, so the fetch-level kill stays as well as the signal rather than instead.
    assert.equal(cancelInFlightCalls, 1);
  });

  test("each entry's cancel reaches only its own lookup", async () => {
    // Per-entry rather than one handle on the queue, so a Stop can't abort a lookup it wasn't aimed
    // at — the row editor's Reprice runs beside these on the same trade2 fetch instance.
    const signals: AbortSignal[] = [];
    const resolver = {
      resolve: (item: ParsedItem, _onTradeSearch?: () => void, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        if (signals.length === 1) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return Promise.resolve({
          ...item, chaosValue: 5, priceSource: "poeninja",
          ignoredMods: [], manualChaosValue: null
        });
      }
    } as unknown as PriceResolver;

    const queue = new PricingQueue(resolver, () => {});
    queue.enqueue(makeItem("Stuck"));
    queue.enqueue(makeItem("Fine"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    queue.cancelCurrent();
    // Past the queue's own THROTTLE_MS, so the second entry has actually started.
    await new Promise((resolve) => setTimeout(resolve, 350));

    assert.equal(signals.length, 2, "the backlog must still have been worked through");
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false, "the next entry inherited the cancel");
  });

  test("the queue moves on to the backlog rather than stopping with it", async () => {
    const priced: Array<Omit<PricedItem, "id">> = [];
    let reject: ((error: Error) => void) | null = null;
    let calls = 0;
    const resolver = {
      resolve: (item: ParsedItem) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise;
          });
        }
        return Promise.resolve({
          ...item, chaosValue: 5, priceSource: "poeninja",
          ignoredMods: [], manualChaosValue: null
        });
      }
    } as unknown as PriceResolver;

    const queue = new PricingQueue(resolver, (item) => priced.push(item), undefined, () =>
      reject?.(new DOMException("This operation was aborted", "AbortError"))
    );
    queue.enqueue(makeItem("Doom Grip"));
    queue.enqueue(makeItem("Chaos Orb"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    queue.cancelCurrent();
    await new Promise((resolve) => setTimeout(resolve, 700));

    // Stop is scoped to the stuck item on purpose. Dropping the backlog with it would make one bad
    // lookup cost every drop captured while it was stuck.
    assert.deepEqual(
      priced.map((p) => [p.name, p.unpricedReason ?? p.priceSource]),
      [
        ["Doom Grip", "cancelled"],
        ["Chaos Orb", "poeninja"]
      ]
    );
  });

  test("a genuine failure after a cancel is still reported as a failure", async () => {
    const priced: Array<Omit<PricedItem, "id">> = [];
    let reject: ((error: Error) => void) | null = null;
    let calls = 0;
    const resolver = {
      resolve: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, rejectPromise) => {
            reject = rejectPromise;
          });
        }
        return Promise.reject(new Error("poe.ninja unreachable"));
      }
    } as unknown as PriceResolver;

    const queue = new PricingQueue(resolver, (item) => priced.push(item), undefined, () =>
      reject?.(new DOMException("This operation was aborted", "AbortError"))
    );
    queue.enqueue(makeItem("Doom Grip"));
    queue.enqueue(makeItem("Chaos Orb"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    queue.cancelCurrent();
    await new Promise((resolve) => setTimeout(resolve, 700));

    // This is why the queue tracks the cancelled *id* and not a boolean: a flag would still be set
    // here and would label a real break as something the user chose.
    assert.deepEqual(
      priced.map((p) => [p.name, p.unpricedReason]),
      [
        ["Doom Grip", "cancelled"],
        ["Chaos Orb", "searchFailed"]
      ]
    );
  });

  test("a lookup that finishes before the abort lands is priced normally", async () => {
    const priced: Array<Omit<PricedItem, "id">> = [];

    // Nothing to interrupt: the resolver answers on its own. The mark is still set, so this is what
    // proves it gets cleared on the way out rather than leaking onto the next item.
    const queue = new PricingQueue(priceableResolver(), (item) => priced.push(item), undefined, () => {});
    queue.enqueue(makeItem("Doom Grip"));
    queue.cancelCurrent();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(priced.length, 1);
    assert.equal(priced[0].priceSource, "poeninja", "a price that arrived is still a price");
    assert.equal(priced[0].unpricedReason, undefined);
  });

  test("constructing without the cancel hook leaves the queue working as before", async () => {
    const priced: Array<Omit<PricedItem, "id">> = [];
    const queue = new PricingQueue(priceableResolver(), (item) => priced.push(item));

    queue.enqueue(makeItem("Doom Grip"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(priced.length, 1);
    assert.equal(priced[0].priceSource, "poeninja");
  });
});
