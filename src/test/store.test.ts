import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as store from "../db/store";
import type { ParsedItem, PricedItem } from "../shared/types";

function makeParsedItem(overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    rawText: "",
    rarity: "Currency",
    name: "Chaos Orb",
    baseType: "Chaos Orb",
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
    capturedAt: Date.now(),
    ...overrides
  };
}

/** Returns the temp userData dir, so tests can inspect the files the store writes. */
async function freshStore(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-store-test-"));
  await store.initStore(dir);
  return dir;
}

async function addItem(overrides: Partial<Omit<PricedItem, "id">> = {}) {
  return store.addPricedItem({
    ...makeParsedItem(),
    chaosValue: 1,
    priceSource: "poeninja",
    ignoredMods: [],
    manualChaosValue: null,
    ...overrides
  });
}

test("updateItem persists the trade median alongside the price it annotates", async () => {
  await freshStore();

  const item = await addItem();

  // The failure mode this guards is silent: `updateItem`'s patch is a `Pick<>` allowlist, and a key
  // missing from it is dropped rather than rejected, so the row would just never show the median.
  await store.updateItem(item.id, {
    chaosValue: 2,
    priceSource: "trade2",
    tradeMedianChaosValue: 10
  });

  const stored = (await store.getAllItems()).find((i) => i.id === item.id);
  assert.equal(stored?.tradeMedianChaosValue, 10);
});

test("updateItem persists the mods the search asked for, which is what the editor ticks", async () => {
  await freshStore();

  const item = await addItem();

  // Same silent failure as the median above: a key missing from `updateItem`'s `Pick<>` allowlist is
  // dropped rather than rejected, and the editor would quietly fall back to ticking every mod.
  await store.updateItem(item.id, {
    chaosValue: 2,
    priceSource: "trade2",
    searchedMods: ["+80 to maximum Life"],
    autoDroppedMods: ["15% increased Rarity of Items found"]
  });

  const stored = (await store.getAllItems()).find((i) => i.id === item.id);
  assert.deepEqual(stored?.searchedMods, ["+80 to maximum Life"]);
  assert.deepEqual(stored?.autoDroppedMods, ["15% increased Rarity of Items found"]);
});

test("updateItem returns null for an unknown item id", async () => {
  await freshStore();
  const result = await store.updateItem("does-not-exist", { manualChaosValue: 5 });
  assert.equal(result, null);
});

test("clearHistory removes every item", async () => {
  await freshStore();

  await addItem();
  await addItem();

  await store.clearHistory();

  assert.deepEqual(await store.getAllItems(), []);
});

test("the cleared state is persisted, not just dropped in memory", async () => {
  const dir = await freshStore();

  await addItem();
  await store.clearHistory();

  // Re-initialising reads the file back, so this fails if clearHistory() forgot to persist.
  await store.initStore(dir);
  assert.deepEqual(await store.getAllItems(), []);
});

test("clearing keeps a one-slot backup of what was deleted", async () => {
  const dir = await freshStore();

  await addItem({ chaosValue: 7 });
  await store.clearHistory();

  const backupPath = path.join(dir, "loot-cache.pre-clear.json");
  assert.ok(fs.existsSync(backupPath), "there is no undo in the app; the backup is the only recourse");

  const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
  assert.equal(backup.items.length, 1);
  assert.equal(backup.items[0].chaosValue, 7);
});

test("a second clear overwrites the backup rather than accumulating files", async () => {
  const dir = await freshStore();

  await addItem({ chaosValue: 1 });
  await store.clearHistory();
  await addItem({ chaosValue: 2 });
  await store.clearHistory();

  const backup = JSON.parse(fs.readFileSync(path.join(dir, "loot-cache.pre-clear.json"), "utf-8"));
  assert.equal(backup.items[0].chaosValue, 2);
  const strays = fs.readdirSync(dir).filter((f) => f.startsWith("loot-cache"));
  assert.deepEqual(strays.sort(), ["loot-cache.json", "loot-cache.pre-clear.json"]);
});

test("clearing an already-empty store is a no-op, not an error", async () => {
  await freshStore();

  await store.clearHistory();
  await store.clearHistory();

  assert.deepEqual(await store.getAllItems(), []);
});

test("a cache written before map sessions were removed still loads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-store-test-"));
  // Exactly what an install from before this change has on disk: a top-level `sessions` array, and a
  // `sessionId` on every item. Nothing migrates the file, so the guarantee is that both simply ride
  // along unread rather than tripping the load — losing someone's whole history to a dropped field.
  fs.writeFileSync(
    path.join(dir, "loot-cache.json"),
    JSON.stringify({
      sessions: [{ id: "s-1", league: "Standard", startedAt: 1, endedAt: null, zoneName: "Vaal Foundry", totalChaosValue: 5 }],
      items: [{ ...makeParsedItem(), id: "i-1", sessionId: "s-1", chaosValue: 5, priceSource: "poeninja", ignoredMods: [], manualChaosValue: null }]
    })
  );

  await store.initStore(dir);

  const items = await store.getAllItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].chaosValue, 5);
});
