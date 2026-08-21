import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PricedItem } from "../shared/types";

interface DbSchema {
  items: PricedItem[];
}

const DEFAULT_DATA: DbSchema = { items: [] };

let data: DbSchema = DEFAULT_DATA;
let filePath: string | null = null;

function persist(): void {
  if (!filePath) throw new Error("Store not initialized — call initStore() first");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export async function initStore(userDataDir: string): Promise<void> {
  filePath = path.join(userDataDir, "loot-cache.json");
  if (fs.existsSync(filePath)) {
    // A cache written before map sessions were removed still carries a `sessions` array and a
    // `sessionId` on every item. Nothing migrates it and nothing reads them any more — the extra
    // keys simply ride along unread, which is the same way every other dropped field is handled.
    data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as DbSchema;
  } else {
    data = { items: [] };
    persist();
  }
}

export async function addPricedItem(item: Omit<PricedItem, "id">): Promise<PricedItem> {
  const stored: PricedItem = { ...item, id: randomUUID() };
  data.items.push(stored);
  persist();
  return stored;
}

export async function getItem(itemId: string): Promise<PricedItem | null> {
  return data.items.find((item) => item.id === itemId) ?? null;
}

export async function updateItem(
  itemId: string,
  // `modMatch`/`defencesDropped` ride along with a reprice and are as much a part of the result as
  // the value itself — a price is not interpretable without them. They were being passed and
  // persisted before they were listed here; a spread of a conditional object skips excess-property
  // checking, so the type simply didn't say so.
  patch: Partial<
    Pick<
      PricedItem,
      | "chaosValue"
      | "priceSource"
      | "unpricedReason"
      | "unpricedDetail"
      | "ignoredMods"
      | "modFilters"
      | "pseudoFilters"
      | "mapFilters"
      | "manualChaosValue"
      | "modMatch"
      | "defencesDropped"
      | "pseudoDropped"
      | "mapDropped"
      | "statCoverage"
      | "coverageSample"
      | "autoDroppedMods"
      | "searchedMods"
      | "tradeSearchId"
      | "tradeListingQuote"
      | "tradeListingIndexedAt"
    >
  >
): Promise<PricedItem | null> {
  const item = data.items.find((i) => i.id === itemId);
  if (!item) return null;

  Object.assign(item, patch);
  persist();
  return item;
}

/**
 * Deletes every item.
 *
 * The previous contents are copied to `loot-cache.pre-clear.json` first. This is the only
 * destructive operation in the app and there is no undo anywhere; one rolling backup slot
 * (overwritten each clear rather than timestamped, so copies can't accumulate forever) is cheap
 * insurance against a mis-click.
 */
export async function clearHistory(): Promise<void> {
  if (!filePath) throw new Error("Store not initialized — call initStore() first");

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, path.join(path.dirname(filePath), "loot-cache.pre-clear.json"));
  }

  data = { items: [] };
  persist();
}

/**
 * Every item ever recorded, in capture order. A copy rather than the live array, so the renderer
 * can't mutate the store; it does its own grouping/sorting/filtering client-side.
 */
export async function getAllItems(): Promise<PricedItem[]> {
  return [...data.items];
}
