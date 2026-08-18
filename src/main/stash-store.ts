import fs from "node:fs";
import path from "node:path";
import type { StashSnapshot } from "../shared/stash-tally";

/**
 * The two stash reads a tally is made of, persisted so closing the app doesn't discard a baseline the
 * user opened hours ago.
 *
 * **This is deliberately not part of `loot-cache.json`, and a snapshot is deliberately not a
 * `PricedItem`.** A stash stack is not a drop: it has no `sessionId`, it was never captured in a map,
 * and it is a *snapshot* rather than an event — read the same tab twice and you have one stash, not
 * two. Filing it with the loot would put it in `allItems`, fold it into `groupItems`, sum it into
 * whichever map happened to be running via `recomputeSessionTotal`, and write it to the CSV export.
 * Separate files mean none of that can happen by accident, in either direction: `clearHistory()`
 * cannot wipe a tally and `clearTally()` cannot wipe the loot history.
 */
interface StashStoreData {
  /** Where the tally was started. Null once cleared, or before the first read. */
  baseline: StashSnapshot | null;
  /** The most recent read. Equal to `baseline` immediately after Start. */
  latest: StashSnapshot | null;
}

const EMPTY: StashStoreData = { baseline: null, latest: null };

let data: StashStoreData = EMPTY;
let filePath: string | null = null;

function persist(): void {
  if (!filePath) throw new Error("Stash store not initialized — call initStashStore() first");
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * A corrupt or half-written file resets rather than throwing. Unlike the loot history this holds
 * nothing that can't be recreated by pressing Start again, so refusing to boot over it would trade a
 * recoverable annoyance for an unrecoverable one.
 */
export function initStashStore(userDataDir: string): void {
  filePath = path.join(userDataDir, "stash-snapshot.json");
  if (!fs.existsSync(filePath)) {
    data = { ...EMPTY };
    persist();
    return;
  }

  try {
    const loaded = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<StashStoreData>;
    data = { baseline: loaded.baseline ?? null, latest: loaded.latest ?? null };
  } catch {
    console.warn("[stash] snapshot file was unreadable — starting from an empty tally");
    data = { ...EMPTY };
    persist();
  }
}

export function getTally(): StashStoreData {
  return { baseline: data.baseline, latest: data.latest };
}

/**
 * Start: this read is both the baseline and the current state. The user gets a total immediately —
 * that is the answer to "what is my currency worth" — and a fixed point to measure the next read
 * against.
 */
export function startTally(snapshot: StashSnapshot): void {
  data = { baseline: snapshot, latest: snapshot };
  persist();
}

/**
 * Read again: the baseline is left exactly where it was, so the diff always spans the whole session
 * rather than only the last leg. Falls back to starting the tally when there is no baseline, since a
 * diff against nothing is not a thing to show.
 */
export function updateTally(snapshot: StashSnapshot): void {
  if (data.baseline === null) {
    startTally(snapshot);
    return;
  }
  data = { baseline: data.baseline, latest: snapshot };
  persist();
}

export function clearTally(): void {
  data = { ...EMPTY };
  persist();
}
