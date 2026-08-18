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

async function addItem(sessionId: string, overrides: Partial<Omit<PricedItem, "id">> = {}) {
  return store.addPricedItem({
    ...makeParsedItem(),
    sessionId,
    chaosValue: 1,
    priceSource: "poeninja",
    ignoredMods: [],
    manualChaosValue: null,
    ...overrides
  });
}

test("session total reflects items added and later edited", async () => {
  await freshStore();

  const session = await store.startSession("Standard", null);

  const priced = await store.addPricedItem({
    ...makeParsedItem({ stackSize: 3 }),
    sessionId: session.id,
    chaosValue: 2,
    priceSource: "poeninja",
    ignoredMods: [],
    manualChaosValue: null
  });

  const unpriced = await store.addPricedItem({
    ...makeParsedItem({ name: "Doom Grip", rarity: "Rare", baseType: "Titan Gauntlets" }),
    sessionId: session.id,
    chaosValue: null,
    priceSource: "unpriced",
    ignoredMods: [],
    manualChaosValue: null
  });

  let sessions = await store.getSessions();
  assert.equal(sessions.find((s) => s.id === session.id)?.totalChaosValue, 6); // 2 * 3 stack

  await store.updateItem(unpriced.id, { manualChaosValue: 40 });

  sessions = await store.getSessions();
  assert.equal(sessions.find((s) => s.id === session.id)?.totalChaosValue, 46); // 6 + 40

  await store.updateItem(priced.id, { manualChaosValue: 0 });

  sessions = await store.getSessions();
  assert.equal(sessions.find((s) => s.id === session.id)?.totalChaosValue, 40); // manual override wins, 0 + 40
});

test("updateItem persists the trade median alongside the price it annotates", async () => {
  await freshStore();

  const session = await store.startSession("Standard", null);
  const item = await addItem(session.id);

  // The failure mode this guards is silent: `updateItem`'s patch is a `Pick<>` allowlist, and a key
  // missing from it is dropped rather than rejected, so the row would just never show the median.
  await store.updateItem(item.id, {
    chaosValue: 2,
    priceSource: "trade2",
    tradeMedianChaosValue: 10
  });

  const stored = (await store.getAllItems()).find((i) => i.id === item.id);
  assert.equal(stored?.tradeMedianChaosValue, 10);
  // The annotation must not leak into the total — that sums the price, which is the floor.
  const sessions = await store.getSessions();
  assert.equal(sessions.find((s) => s.id === session.id)?.totalChaosValue, 2);
});

test("updateItem returns null for an unknown item id", async () => {
  await freshStore();
  const result = await store.updateItem("does-not-exist", { manualChaosValue: 5 });
  assert.equal(result, null);
});

test("clearHistory removes every session and item", async () => {
  await freshStore();

  const session = await store.startSession("Standard", null);
  await addItem(session.id);
  await addItem(session.id);

  await store.clearHistory();

  assert.deepEqual(await store.getSessions(), []);
  assert.deepEqual(await store.getAllItems(), []);
  // This is what lets ensureActiveSession() open a fresh session on the next capture instead of
  // filing items against the deleted one.
  assert.equal(await store.getActiveSession(), null);
});

test("the cleared state is persisted, not just dropped in memory", async () => {
  const dir = await freshStore();

  const session = await store.startSession("Standard", null);
  await addItem(session.id);
  await store.clearHistory();

  // Re-initialising reads the file back, so this fails if clearHistory() forgot to persist.
  await store.initStore(dir);
  assert.deepEqual(await store.getSessions(), []);
});

test("clearing keeps a one-slot backup of what was deleted", async () => {
  const dir = await freshStore();

  const session = await store.startSession("Standard", "Vaal Foundry");
  await addItem(session.id);
  await store.clearHistory();

  const backupPath = path.join(dir, "loot-cache.pre-clear.json");
  assert.ok(fs.existsSync(backupPath), "there is no undo in the app; the backup is the only recourse");

  const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
  assert.equal(backup.sessions.length, 1);
  assert.equal(backup.sessions[0].zoneName, "Vaal Foundry");
  assert.equal(backup.items.length, 1);
});

test("a second clear overwrites the backup rather than accumulating files", async () => {
  const dir = await freshStore();

  await store.startSession("Standard", "First Map");
  await store.clearHistory();
  await store.startSession("Standard", "Second Map");
  await store.clearHistory();

  const backup = JSON.parse(fs.readFileSync(path.join(dir, "loot-cache.pre-clear.json"), "utf-8"));
  assert.equal(backup.sessions[0].zoneName, "Second Map");
  const strays = fs.readdirSync(dir).filter((f) => f.startsWith("loot-cache"));
  assert.deepEqual(strays.sort(), ["loot-cache.json", "loot-cache.pre-clear.json"]);
});

test("clearing an already-empty store is a no-op, not an error", async () => {
  await freshStore();

  await store.clearHistory();
  await store.clearHistory();

  assert.deepEqual(await store.getSessions(), []);
});

test("a session started after clearing tracks its own total normally", async () => {
  await freshStore();

  const stale = await store.startSession("Standard", "Old Map");
  await addItem(stale.id, { chaosValue: 5 });
  await store.clearHistory();

  const fresh = await store.startSession("Standard", "New Map");
  await addItem(fresh.id, { chaosValue: 3, stackSize: 2 });

  const sessions = await store.getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].totalChaosValue, 6);
});
