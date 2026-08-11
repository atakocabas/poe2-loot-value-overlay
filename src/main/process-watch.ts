import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";

const POLL_INTERVAL_MS = 5000;

function listAllProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    // CSV rather than the default table layout: image names can contain spaces ("Exiled Exchange
    // 2.exe"), which makes column-splitting the table format unreliable. `/NH` drops the header.
    execFile("tasklist", ["/NH", "/FO", "CSV"], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Returns the image name of the first running process matching one of `names`, or null.
 *
 * Matches the image-name column exactly (case-insensitively) rather than substring-searching the
 * whole listing, so an unrelated process whose command line happens to mention the name can't
 * produce a false positive.
 */
export function matchRunningProcess(tasklistCsv: string, names: string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const row of tasklistCsv.split(/\r?\n/)) {
    const imageName = row.match(/^"([^"]*)"/)?.[1];
    if (imageName && wanted.has(imageName.toLowerCase())) return imageName;
  }
  return null;
}

export declare interface ProcessWatcher {
  on(event: "started", listener: (imageName: string) => void): this;
  on(event: "stopped", listener: () => void): this;
}

/**
 * Polls the Windows process list for the PoE2 game executable so the overlay can show itself when
 * the game launches, and pause the clipboard watcher when it exits. Uses `tasklist` via `execFile`
 * (not `exec`, so process names are never interpreted by a shell). A failed listing (e.g. not
 * running on Windows) is treated as "unknown" rather than "stopped" — it doesn't flip state or
 * emit anything, just logs once, so a transient failure can't spuriously deactivate the overlay.
 *
 * Takes a list of candidate image names because the client's executable name varies by install
 * (Steam vs standalone) and has changed across builds. A stale single name used to silently
 * disable everything gated behind this watcher, so a miss is now logged loudly and once.
 */
export class ProcessWatcher extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningAs: string | null = null;
  private warnedListFailure = false;
  private warnedNotFound = false;

  constructor(
    private readonly processNames: string[],
    private readonly listProcesses: () => Promise<string> = listAllProcesses
  ) {
    super();
  }

  start(): void {
    void this.checkOnce();
    this.timer = setInterval(() => void this.checkOnce(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkOnce(): Promise<void> {
    let stdout: string;
    try {
      stdout = await this.listProcesses();
    } catch (error) {
      if (!this.warnedListFailure) {
        this.warnedListFailure = true;
        console.warn("[process-watch] failed to list processes", (error as Error).message);
      }
      return;
    }

    const matched = matchRunningProcess(stdout, this.processNames);
    if (matched && !this.runningAs) {
      this.runningAs = matched;
      this.warnedNotFound = false;
      this.emit("started", matched);
    } else if (!matched && this.runningAs) {
      this.runningAs = null;
      this.emit("stopped");
    } else if (!matched && !this.warnedNotFound) {
      this.warnedNotFound = true;
      console.warn(
        `[process-watch] no PoE2 process found — looked for ${this.processNames.join(", ")}. ` +
          "If the game is running, add its .exe name to poe2ProcessNames in settings.json."
      );
    }
  }
}
