import { EventEmitter } from "node:events";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

// PoE2's Client.txt does not use PoE1's "You have entered X." line at all. Zone transitions
// show up as `[SCENE] Set Source [ZoneName]`, with a `[SCENE] Set Source [(null)]` line
// immediately before it during the loading transition — that placeholder must be ignored.
const ZONE_ENTER_PATTERN = /\[SCENE\] Set Source \[(.+?)\]\s*$/;
const HUB_ZONE_PATTERN = /Hideout|^Atlas$/i;
const HIDEOUT_PATTERN = /Hideout/i;

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_BACKFILL_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
/** How long with zero new bytes before we log that the tailer is alive but seeing nothing. */
const SILENCE_WARN_MS = 60_000;

export interface ZoneChangeEvent {
  zoneName: string;
  isHideoutOrTown: boolean;
  isHideout: boolean;
}

export interface LogWatchOptions {
  pollIntervalMs?: number;
  backfillBytes?: number;
  debugLogging?: boolean;
  /** Set false to skip the interval and `fs.watch` triggers and drive `pollOnce()` by hand (tests). */
  autoPoll?: boolean;
}

/** Pure zone-name classification, split out from handleLine() so it's unit-testable without fs/EventEmitter. */
export function classifyZone(zoneName: string): { isHideoutOrTown: boolean; isHideout: boolean } {
  return { isHideoutOrTown: HUB_ZONE_PATTERN.test(zoneName), isHideout: HIDEOUT_PATTERN.test(zoneName) };
}

/** Returns the zone name from a Client.txt line, or null if it isn't a real zone transition. */
function matchZoneLine(line: string): string | null {
  const zoneName = line.match(ZONE_ENTER_PATTERN)?.[1];
  if (!zoneName || zoneName === "(null)" || zoneName === "(unknown)") return null;
  return zoneName;
}

export declare interface ClientLogWatcher {
  on(event: "zone-change", listener: (change: ZoneChangeEvent) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

/**
 * Tails Client.txt for zone-transition lines to auto-detect map start/end.
 * Heuristic: entering a "Hideout" or the "Atlas" map-select screen marks the end of a map
 * session (you left to sell loot or pick the next map); entering anything else marks the start
 * of a new one. Matches the normal hideout/atlas -> map -> hideout/atlas loop, but is a
 * heuristic, not a guarantee (e.g. campaign act/town zones mid-run aren't distinguished).
 *
 * Two Windows-specific traps shape the implementation, both measured against a live 283 MB
 * Client.txt while the game held it open:
 *
 * 1. `fs.stat()` reports a *stale* size for a file another process has open — it lagged the real
 *    length by ~250 bytes. So the reported size is never used to bound a read; `readSync`'s
 *    return value is the only number that reflects what's actually readable, and that is what
 *    advances the offset. Size is consulted solely to detect truncation.
 * 2. `fs.watch` (ReadDirectoryChangesW) doesn't reliably fire for buffered appends to that same
 *    open file. An interval poll is the real trigger; the watcher is just an extra nudge.
 */
export class ClientLogWatcher extends EventEmitter {
  private fd: number | null = null;
  private readPosition = 0;
  /** Bytes read but not yet terminated by a newline, carried in memory until the rest arrives. */
  private pendingPartial = "";
  private decoder = new StringDecoder("utf8");
  private inFlight = false;
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReadAt = 0;
  private warnedSilent = false;
  private readonly pollIntervalMs: number;
  private readonly backfillBytes: number;
  private readonly debugLogging: boolean;
  private readonly autoPoll: boolean;

  constructor(private readonly logPath: string, options: LogWatchOptions = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.backfillBytes = options.backfillBytes ?? DEFAULT_BACKFILL_BYTES;
    this.debugLogging = options.debugLogging ?? false;
    this.autoPoll = options.autoPoll ?? true;
  }

  start(): void {
    if (!this.logPath || !fs.existsSync(this.logPath)) {
      this.emit("error", new Error(`Client.txt not found at "${this.logPath}"`));
      return;
    }

    try {
      this.fd = fs.openSync(this.logPath, "r");
    } catch (error) {
      this.emit("error", new Error(`Client.txt could not be opened: ${(error as Error).message}`));
      return;
    }

    const size = this.currentSize();
    this.readPosition = size;
    this.lastReadAt = Date.now();
    console.log(
      `[logwatch] tailing "${this.logPath}" (size=${size}, offset=${this.readPosition}, poll=${this.pollIntervalMs}ms)`
    );

    this.backfillCurrentZone(size);

    if (!this.autoPoll) return;
    this.timer = setInterval(() => this.pollOnce(), this.pollIntervalMs);
    try {
      this.watcher = fs.watch(this.logPath, { persistent: false }, () => this.pollOnce());
    } catch (error) {
      // Not fatal — the interval poll covers everything fs.watch would have told us.
      console.warn(`[logwatch] fs.watch unavailable, relying on the ${this.pollIntervalMs}ms poll`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
    this.pendingPartial = "";
    this.decoder = new StringDecoder("utf8");
  }

  /**
   * Reads everything available past `readPosition` and emits a zone-change per complete line.
   * Public so tests can drive it deterministically without waiting on timers.
   */
  pollOnce(): void {
    // Reads are synchronous, so this can only re-enter via fs.watch firing during the read —
    // but the guard also keeps a slow read from being restarted by the interval mid-flight,
    // which would replay the same offset range and emit duplicate zone changes.
    if (this.fd === null || this.inFlight) return;
    this.inFlight = true;
    try {
      this.drain();
    } catch (error) {
      this.emit("error", error as Error);
    } finally {
      this.inFlight = false;
    }
  }

  private currentSize(): number {
    return this.fd === null ? 0 : fs.fstatSync(this.fd).size;
  }

  private drain(): void {
    const size = this.currentSize();
    if (size < this.readPosition) {
      console.log(`[logwatch] file shrank (${this.readPosition} -> ${size}), restarting from the top`);
      this.readPosition = 0;
      this.pendingPartial = "";
      this.decoder = new StringDecoder("utf8");
    }

    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let totalBytes = 0;
    let totalLines = 0;
    for (;;) {
      const bytesRead = fs.readSync(this.fd!, buffer, 0, buffer.length, this.readPosition);
      if (bytesRead === 0) break;
      this.readPosition += bytesRead;
      totalBytes += bytesRead;
      totalLines += this.consume(buffer.subarray(0, bytesRead));
      if (bytesRead < buffer.length) break;
    }

    if (totalBytes > 0) {
      this.lastReadAt = Date.now();
      this.warnedSilent = false;
      if (this.debugLogging) {
        const carried = this.pendingPartial ? `, ${Buffer.byteLength(this.pendingPartial)}b partial carried` : "";
        console.log(`[logwatch] read ${totalBytes}b, ${totalLines} lines (offset now ${this.readPosition}${carried})`);
      }
      return;
    }

    if (!this.warnedSilent && Date.now() - this.lastReadAt > SILENCE_WARN_MS) {
      this.warnedSilent = true;
      console.warn(
        `[logwatch] no new bytes from "${this.logPath}" in ${SILENCE_WARN_MS / 1000}s — the tailer is ` +
          "alive but the file isn't growing. Is this the Client.txt the running game writes to?"
      );
    }
  }

  /**
   * Feeds one chunk through the line splitter and returns how many complete lines it produced.
   * The trailing fragment is kept in `pendingPartial` instead of being rewound in the file, so a
   * zone line straddling a read boundary is still seen exactly once, when its remainder arrives.
   * `StringDecoder` does the same for a multi-byte character split across chunks.
   */
  private consume(chunk: Buffer): number {
    const parts = (this.pendingPartial + this.decoder.write(chunk)).split(/\r?\n/);
    this.pendingPartial = parts.pop() ?? "";
    for (const line of parts) this.handleLine(line);
    return parts.length;
  }

  /**
   * Seeds the current zone from the tail of the log so launching the overlay mid-map doesn't sit
   * on "No active map" until the next transition. Emits at most one event — the most recent real
   * zone line — so historical zones are never replayed as sessions.
   */
  private backfillCurrentZone(size: number): void {
    if (this.backfillBytes <= 0 || this.fd === null || size <= 0) return;

    const length = Math.min(this.backfillBytes, size);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(this.fd, buffer, 0, length, size - length);
    if (bytesRead === 0) return;

    const lines = buffer.subarray(0, bytesRead).toString("utf-8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const zoneName = matchZoneLine(lines[i]);
      if (!zoneName) continue;
      console.log(`[logwatch] backfill: current zone "${zoneName}"`);
      this.emit("zone-change", { zoneName, ...classifyZone(zoneName) });
      return;
    }
    if (this.debugLogging) {
      console.log(`[logwatch] backfill: no zone line found in the last ${bytesRead}b`);
    }
  }

  private handleLine(line: string): void {
    const match = line.match(ZONE_ENTER_PATTERN);
    if (!match) return;

    const zoneName = match[1];
    if (zoneName === "(null)" || zoneName === "(unknown)") {
      if (this.debugLogging) console.log(`[logwatch] skipping placeholder zone "${zoneName}"`);
      return;
    }

    console.log(`[logwatch] zone line matched: "${zoneName}"`);
    this.emit("zone-change", { zoneName, ...classifyZone(zoneName) });
  }
}
