import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

/** A running foreground-window reporter. Abstracted so tests can drive the watcher without a shell. */
export interface ForegroundHelper {
  stop(): void;
}

export interface ForegroundHelperHandlers {
  onLine(line: string): void;
  onFailure(message: string): void;
}

/**
 * PowerShell polls the foreground window *itself* and prints only on change, so we pay the process
 * spawn (plus the one-off `Add-Type` compile) exactly once instead of every poll — a per-poll
 * `execFile` like `process-watch.ts` uses would cost hundreds of ms and can't run at focus-tracking
 * frequency. Windows exposes no foreground-window info to Electron and this project keeps zero
 * native deps (see CLAUDE.md), so shelling out is the available route.
 *
 * Emitted lines are `<pid>|<processName>`, where processName is Win32's, i.e. without the `.exe`
 * suffix that `settings.poe2ProcessNames` entries carry.
 */
function buildPollScript(pollIntervalMs: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Poe2Overlay -Name Win32 -MemberDefinition @'",
    '[DllImport("user32.dll")]',
    "public static extern System.IntPtr GetForegroundWindow();",
    '[DllImport("user32.dll")]',
    "public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int processId);",
    "'@",
    "$lastHandle = [System.IntPtr]::Zero",
    "while ($true) {",
    "  $handle = [Poe2Overlay.Win32]::GetForegroundWindow()",
    "  if ($handle -ne $lastHandle) {",
    "    $lastHandle = $handle",
    // NOTE: not $pid — that is a PowerShell automatic variable holding the helper's own PID.
    "    $procId = 0",
    "    [void][Poe2Overlay.Win32]::GetWindowThreadProcessId($handle, [ref]$procId)",
    "    $name = ''",
    "    try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $name = '' }",
    "    Write-Output ('{0}|{1}' -f $procId, $name)",
    "  }",
    `  Start-Sleep -Milliseconds ${pollIntervalMs}`,
    "}"
  ].join("\n");
}

/**
 * Spawns the poller. The script is passed as `-EncodedCommand` (base64 of UTF-16LE, which is what
 * PowerShell expects) so none of its quoting — the C# here-string in particular — has to survive
 * Windows command-line escaping.
 */
function spawnPowerShellHelper(pollIntervalMs: number, handlers: ForegroundHelperHandlers): ForegroundHelper {
  const encoded = Buffer.from(buildPollScript(pollIntervalMs), "utf16le").toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
  );

  // stdout arrives in arbitrary chunks; hold the trailing partial line until its newline shows up.
  let pending = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handlers.onLine(line.trim());
  });

  // Our own kill() makes the child exit; that's not a failure worth reporting.
  let stopping = false;
  const reportFailure = (message: string) => {
    if (!stopping) handlers.onFailure(message);
  };

  // stderr is NOT treated as a failure on its own: powershell.exe emits a `#< CLIXML` serialization
  // preamble there as soon as stderr is redirected, even on a completely healthy run. It's only
  // kept as diagnostics to attach to a real exit, since $ErrorActionPreference = 'Stop' means any
  // genuine error terminates the loop and surfaces as an exit anyway.
  let stderrText = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderrText = (stderrText + chunk).slice(-2000);
  });
  child.on("error", (error) => reportFailure(error.message));
  child.on("exit", (code) =>
    reportFailure(`helper exited with code ${code}${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`)
  );

  return {
    stop: () => {
      stopping = true;
      child.kill();
    }
  };
}

function normalizeProcessName(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, "");
}

export declare interface ForegroundWatcher {
  on(event: "focused", listener: () => void): this;
  on(event: "unfocused", listener: () => void): this;
  on(event: "unavailable", listener: (message: string) => void): this;
}

/**
 * Tracks whether the PoE2 game window is the OS foreground window, so the overlay can hide itself
 * when the player alt-tabs away instead of covering whatever they switched to.
 *
 * Mirrors `ProcessWatcher`'s shape: edge-triggered events only, and a failure of the underlying
 * query is "unknown" rather than "not focused" — it emits `unavailable` (once) and leaves focus
 * state untouched, so consumers can fail *open* and keep the overlay visible. A helper that can't
 * run must never leave the overlay permanently invisible.
 *
 * A foreground process we can't resolve (nothing focused, or a process we lack rights to inspect)
 * *is* treated as "not PoE2" — the player did switch away. The consumer's hide delay absorbs the
 * momentary unresolvable foreground that PoE2 produces during loading screens.
 */
export class ForegroundWatcher extends EventEmitter {
  private readonly targetNames: Set<string>;
  private helper: ForegroundHelper | null = null;
  private isFocused = false;
  private warnedOnce = false;

  constructor(
    processNames: string[],
    private readonly pollIntervalMs: number,
    private readonly spawnHelper: (
      pollIntervalMs: number,
      handlers: ForegroundHelperHandlers
    ) => ForegroundHelper = spawnPowerShellHelper
  ) {
    super();
    // Same candidate list as ProcessWatcher: if none of these ever matches, focus is never
    // detected and the overlay would stay hidden forever, so it must not hinge on one exact name.
    this.targetNames = new Set(processNames.map(normalizeProcessName));
  }

  start(): void {
    if (this.helper) return;
    try {
      this.helper = this.spawnHelper(this.pollIntervalMs, {
        onLine: (line) => this.handleLine(line),
        onFailure: (message) => this.handleHelperFailure(message)
      });
    } catch (error) {
      this.handleHelperFailure((error as Error).message);
    }
  }

  stop(): void {
    this.helper?.stop();
    this.helper = null;
    // Reset so a later start() re-emits the current state rather than assuming it's unchanged.
    this.isFocused = false;
  }

  /** Public so tests can drive state transitions without spawning the helper. */
  handleLine(line: string): void {
    const separator = line.indexOf("|");
    if (separator < 0) return;
    const pid = line.slice(0, separator).trim();
    if (!/^\d+$/.test(pid)) return; // not one of our records (stray helper output)

    const focused = this.targetNames.has(normalizeProcessName(line.slice(separator + 1)));
    if (focused && !this.isFocused) {
      this.isFocused = true;
      this.emit("focused");
    } else if (!focused && this.isFocused) {
      this.isFocused = false;
      this.emit("unfocused");
    }
  }

  /** Public for the same reason as `handleLine`. Does not change focus state — see class docs. */
  handleHelperFailure(message: string): void {
    if (this.warnedOnce) return;
    this.warnedOnce = true;
    this.emit("unavailable", message);
  }
}
