import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClientLogWatcher, classifyZone, type ZoneChangeEvent } from "../main/logwatch";

test("a hideout zone is classified as both hideout-or-town and hideout", () => {
  assert.deepEqual(classifyZone("Some Guy's Hideout"), { isHideoutOrTown: true, isHideout: true });
});

test("the Atlas screen is hideout-or-town but not hideout", () => {
  assert.deepEqual(classifyZone("Atlas"), { isHideoutOrTown: true, isHideout: false });
});

test("an ordinary map/campaign zone is neither", () => {
  assert.deepEqual(classifyZone("The Ridge"), { isHideoutOrTown: false, isHideout: false });
});

/** A real Client.txt zone line, matching the format captured from a live PoE2 install. */
function zoneLine(zoneName: string): string {
  return `2026/08/05 19:04:19 367216937 3ef231e0 [INFO Client 29772] [SCENE] Set Source [${zoneName}]\r\n`;
}

interface Harness {
  logPath: string;
  zones: string[];
  append(text: string): void;
  poll(): void;
}

/**
 * Runs `body` against a watcher tailing a real temp file. `autoPoll: false` keeps the interval and
 * fs.watch out of it so every read is driven explicitly by `poll()` and the assertions are exact.
 */
function withWatcher(
  initialContent: string,
  options: { backfillBytes?: number },
  body: (harness: Harness) => void
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poe2-logwatch-"));
  const logPath = path.join(dir, "Client.txt");
  fs.writeFileSync(logPath, initialContent);

  const watcher = new ClientLogWatcher(logPath, {
    autoPoll: false,
    backfillBytes: options.backfillBytes ?? 0
  });
  const zones: string[] = [];
  watcher.on("zone-change", (event: ZoneChangeEvent) => zones.push(event.zoneName));

  try {
    watcher.start();
    body({
      logPath,
      zones,
      append: (text) => fs.appendFileSync(logPath, text),
      poll: () => watcher.pollOnce()
    });
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a zone line appended after start is emitted once", () => {
  withWatcher("", {}, ({ append, poll, zones }) => {
    append(zoneLine("Reservoir"));
    poll();
    assert.deepEqual(zones, ["Reservoir"]);
  });
});

test("a zone line split across two reads is emitted exactly once, when its remainder arrives", () => {
  withWatcher("", {}, ({ append, poll, zones }) => {
    const line = zoneLine("Sandswept Marsh");
    const cut = Math.floor(line.length / 2);

    append(line.slice(0, cut));
    poll();
    assert.deepEqual(zones, [], "a partial line must not emit anything yet");

    append(line.slice(cut));
    poll();
    assert.deepEqual(zones, ["Sandswept Marsh"], "the completed line must not be lost at the boundary");
  });
});

test("polling with no new bytes emits nothing and does not replay earlier lines", () => {
  withWatcher("", {}, ({ append, poll, zones }) => {
    append(zoneLine("Reservoir"));
    poll();
    poll();
    poll();
    assert.deepEqual(zones, ["Reservoir"]);
  });
});

test("content written before start is not replayed as zone changes", () => {
  withWatcher(zoneLine("The Ridge") + zoneLine("Reservoir"), {}, ({ poll, zones }) => {
    poll();
    assert.deepEqual(zones, []);
  });
});

test("(null) and (unknown) placeholder zones never emit", () => {
  withWatcher("", {}, ({ append, poll, zones }) => {
    append(zoneLine("(null)") + zoneLine("(unknown)") + zoneLine("Shrine Hideout"));
    poll();
    assert.deepEqual(zones, ["Shrine Hideout"]);
  });
});

// Rotation is detected by the file shrinking below the current read offset, which is what
// actually happens when Client.txt is replaced: the offset is deep into a large file and the
// replacement starts near zero.
test("a rotated/truncated log resets to the top and keeps reading", () => {
  withWatcher("", {}, ({ append, poll, zones, logPath }) => {
    append(zoneLine("The Ridge") + zoneLine("Reservoir") + zoneLine("Sandswept Marsh"));
    poll();
    assert.deepEqual(zones, ["The Ridge", "Reservoir", "Sandswept Marsh"]);

    fs.truncateSync(logPath, 0);
    append(zoneLine("Shrine Hideout"));
    poll();

    assert.deepEqual(zones, ["The Ridge", "Reservoir", "Sandswept Marsh", "Shrine Hideout"]);
  });
});

test("backfill seeds only the most recent real zone, not the whole history", () => {
  const history = zoneLine("The Ridge") + zoneLine("Reservoir") + zoneLine("(null)");
  withWatcher(history, { backfillBytes: 65536 }, ({ zones, poll }) => {
    assert.deepEqual(zones, ["Reservoir"], "only the latest non-placeholder zone should be seeded");
    poll();
    assert.deepEqual(zones, ["Reservoir"], "backfilled bytes must not be tailed a second time");
  });
});

test("backfill is skipped when backfillBytes is 0", () => {
  withWatcher(zoneLine("Reservoir"), { backfillBytes: 0 }, ({ zones }) => {
    assert.deepEqual(zones, []);
  });
});
