import assert from "node:assert/strict";
import { test } from "node:test";
import { PricingQueue } from "../pricing/queue";
import type { PriceResolver } from "../pricing/price-resolver";
import type { ParsedItem, PricedItem } from "../shared/types";

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

  const queue = new PricingQueue(resolver, () => "session-1", (item) => priced.push(item));
  queue.enqueue(makeItem("Divine Orb"));
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(priced.length, 1, "a failed resolution must not silently drop the drop");
  assert.equal(priced[0].name, "Divine Orb");
  assert.equal(priced[0].sessionId, "session-1");
  assert.equal(priced[0].chaosValue, null);
  assert.equal(priced[0].priceSource, "unpriced");
});

test("a failure does not stall the items queued behind it", async () => {
  const priced: Array<Omit<PricedItem, "id">> = [];
  let calls = 0;
  const resolver = {
    resolve: async (item: ParsedItem, sessionId: string) => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { ...item, sessionId, chaosValue: 5, priceSource: "poeninja", ignoredMods: [], manualChaosValue: null };
    }
  } as unknown as PriceResolver;

  const queue = new PricingQueue(resolver, () => "session-1", (item) => priced.push(item));
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
