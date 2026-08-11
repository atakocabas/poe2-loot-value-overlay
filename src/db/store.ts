import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PricedItem, Session } from "../shared/types";
import { totalChaosValue } from "../shared/effective-value";

interface DbSchema {
  sessions: Session[];
  items: PricedItem[];
}

const DEFAULT_DATA: DbSchema = { sessions: [], items: [] };

let data: DbSchema = DEFAULT_DATA;
let filePath: string | null = null;

function persist(): void {
  if (!filePath) throw new Error("Store not initialized — call initStore() first");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function recomputeSessionTotal(sessionId: string): void {
  const session = data.sessions.find((s) => s.id === sessionId);
  if (!session) return;

  session.totalChaosValue = data.items
    .filter((item) => item.sessionId === sessionId)
    .reduce((total, item) => total + (totalChaosValue(item) ?? 0), 0);
}

export async function initStore(userDataDir: string): Promise<void> {
  filePath = path.join(userDataDir, "loot-cache.json");
  if (fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as DbSchema;
  } else {
    data = { sessions: [], items: [] };
    persist();
  }
}

export async function startSession(league: string, zoneName: string | null): Promise<Session> {
  const session: Session = {
    id: randomUUID(),
    league,
    startedAt: Date.now(),
    endedAt: null,
    zoneName,
    totalChaosValue: 0
  };
  data.sessions.push(session);
  persist();
  return session;
}

export async function endSession(sessionId: string): Promise<void> {
  const session = data.sessions.find((s) => s.id === sessionId);
  if (!session || session.endedAt) return;
  session.endedAt = Date.now();
  persist();
}

export async function getActiveSession(): Promise<Session | null> {
  const active = data.sessions.filter((s) => s.endedAt === null);
  return active.length > 0 ? active[active.length - 1] : null;
}

export async function addPricedItem(item: Omit<PricedItem, "id">): Promise<PricedItem> {
  const stored: PricedItem = { ...item, id: randomUUID() };
  data.items.push(stored);
  recomputeSessionTotal(item.sessionId);
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
      "chaosValue" | "priceSource" | "ignoredMods" | "manualChaosValue" | "modMatch" | "defencesDropped"
    >
  >
): Promise<PricedItem | null> {
  const item = data.items.find((i) => i.id === itemId);
  if (!item) return null;

  Object.assign(item, patch);
  recomputeSessionTotal(item.sessionId);
  persist();
  return item;
}

/**
 * Deletes every session and every item.
 *
 * The previous contents are copied to `loot-cache.pre-clear.json` first. This is the only
 * destructive operation in the app and there is no undo anywhere; one rolling backup slot
 * (overwritten each clear rather than timestamped, so copies can't accumulate forever) is cheap
 * insurance against a mis-click.
 *
 * Callers holding a session in memory — `currentSession` in `main/index.ts` — must drop it, or
 * subsequent items get a `sessionId` no session has and `recomputeSessionTotal()` silently skips
 * them.
 */
export async function clearHistory(): Promise<void> {
  if (!filePath) throw new Error("Store not initialized — call initStore() first");

  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, path.join(path.dirname(filePath), "loot-cache.pre-clear.json"));
  }

  data = { sessions: [], items: [] };
  persist();
}

export async function getSessions(): Promise<Session[]> {
  return [...data.sessions].sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Every item ever recorded, in capture order. The panel shows one flat list rather than a
 * per-session drill-down, so it asks for the lot and does its own grouping/sorting/filtering
 * client-side; a copy rather than the live array, so the renderer can't mutate the store.
 */
export async function getAllItems(): Promise<PricedItem[]> {
  return [...data.items];
}
