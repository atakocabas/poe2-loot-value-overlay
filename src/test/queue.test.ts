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
