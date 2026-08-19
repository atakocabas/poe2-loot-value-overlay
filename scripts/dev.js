/**
 * The iterative loop: compile, run, and restart the app on every change under `src/`.
 *
 * Hand-rolled and dependency-free like the rest of scripts/, and it stays that way because four
 * things about *this* app — and about watching files on Windows — decide how a restart has to be
 * performed. None of them is tidiness, and an off-the-shelf watcher knows about none of them:
 *
 *  - `src/main/index.ts` takes `app.requestSingleInstanceLock()`. Spawning the replacement before
 *    the old process has fully exited loses that lock and the new copy quits on the spot, which
 *    reads as the app vanishing rather than restarting. So the respawn waits for `exit`.
 *  - `ForegroundWatcher` spawns a long-lived PowerShell helper as an ordinary (non-detached) child
 *    and cleans it up from `will-quit`. On Windows `child.kill()` is `TerminateProcess`, which runs
 *    no `will-quit` and does not take children with it — so a plain kill orphans one polling
 *    PowerShell per restart. `taskkill /T` collects the whole tree instead.
 *  - `tsc --watch` re-emits the whole project on *its* first pass, so an app started before that
 *    pass lands is immediately restarted by it. Hence the boot gate below: nothing starts, and
 *    nothing watches `dist/`, until that first compile has been seen.
 *  - **A watch event is not a write.** libuv asks Windows for `FILE_NOTIFY_CHANGE_LAST_ACCESS`
 *    among others, so merely *reading* a file fires `fs.watch` — and the app reads
 *    `dist/renderer/*.html|css` on every launch, which was observed restarting it a second time for
 *    a file nothing had written. Every event is therefore checked against the file's mtime (see
 *    `writtenSince`), which a read does not move. Without that the loop can restart itself
 *    indefinitely; it only *looked* stable because NTFS updates access times at most hourly.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const rendererSrc = path.join(root, "src", "renderer");
const mainEntry = path.join(dist, "main", "index.js");

/** One tsc emit rewrites dozens of files; this is what makes that one restart instead of dozens. */
const DEBOUNCE_MS = 300;
/** If tsc's watch-mode banner never arrives, boot anyway rather than sitting here forever. */
const FIRST_COMPILE_TIMEOUT_MS = 60_000;

const node = process.execPath;
const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");
// The `electron` package's main export is the absolute path to the binary — spawning that directly
// keeps the .cmd shim, and the extra cmd.exe layer it puts in the process tree, out of the way.
const electronBin = require("electron");

function run(label, script) {
  const result = spawnSync(node, [path.join("scripts", script)], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) console.error(`[dev] ${label} failed`);
}

/** True only if the file was actually written since `since` — see the access-time note above. */
function writtenSince(file, since) {
  try {
    return fs.statSync(file).mtimeMs > since;
  } catch {
    // Deleted, or renamed out from under us mid-emit. Nothing to restart into.
    return false;
  }
}

/** Kills a process *and its children*; see the PowerShell helper note above. */
function treeKill(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
}

let app = null;
let restarting = false;
let pendingReason = null;
let timer = null;
/** When the running app was launched: writes older than this are the build it is already running. */
let launchedAt = 0;
/** When the renderer assets were last copied, for the same test on the source side. */
let copiedAt = 0;

function copyAssets() {
  copiedAt = Date.now();
  run("copy-assets", "copy-assets.js");
}

function startApp() {
  launchedAt = Date.now();
  if (!fs.existsSync(mainEntry)) {
    console.error("[dev] nothing compiled yet — fix the errors above and save again");
    return;
  }
  app = spawn(electronBin, ["."], { cwd: root, stdio: "inherit" });
  const child = app;
  child.on("exit", (code) => {
    // A restart kills it on purpose; only an exit we didn't ask for is worth reporting.
    if (app !== child) return;
    app = null;
    if (!restarting) console.log(`[dev] app exited (${code}) — waiting for the next change`);
  });
}

async function restart(reason) {
  restarting = true;
  console.log(`[dev] restarting — ${reason}`);
  const old = app;
  if (old) {
    const exited = new Promise((resolve) => old.once("exit", resolve));
    treeKill(old);
    // The single-instance lock is held until the old process is gone, so this await is load-bearing.
    await exited;
    app = null;
  }
  restarting = false;
  startApp();
}

function scheduleRestart(reason) {
  pendingReason = reason;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const why = pendingReason;
    pendingReason = null;
    // A restart already in flight has its own kill/wait to finish, and the change that arrived
    // mid-flight is already on disk — the copy it is about to spawn picks it up.
    if (!restarting) void restart(why);
  }, DEBOUNCE_MS);
}

// --- tsc ----------------------------------------------------------------------------------------
// `--noEmitOnError` is the deliberate part: a compile error emits nothing, so dist/ keeps the last
// good build, the running app keeps running, and half-typed code never triggers a restart.
// `--preserveWatchOutput` stops tsc clearing the screen over the restart lines. Its output is piped
// rather than inherited only so the first compile can be waited for; every chunk is forwarded.
console.log("[dev] compiling...");
const tsc = spawn(
  node,
  [tscBin, "-p", "tsconfig.json", "--watch", "--preserveWatchOutput", "--noEmitOnError"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
);
tsc.stderr.on("data", (chunk) => process.stderr.write(chunk));

let booted = false;
tsc.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (!booted && String(chunk).includes("Watching for file changes")) boot();
});
const bootTimeout = setTimeout(() => {
  if (!booted) boot();
}, FIRST_COMPILE_TIMEOUT_MS);

/** Runs once, after tsc's first pass: finish the build, arm the watchers, launch the app. */
function boot() {
  booted = true;
  clearTimeout(bootTimeout);

  // The other two thirds of `npm run build`, in the same order and through the same scripts.
  // make-icons requires the mark's geometry out of dist/, so it cannot run before tsc has emitted.
  copyAssets();
  run("make-icons", "make-icons.js");

  startApp();

  fs.mkdirSync(dist, { recursive: true });
  fs.watch(dist, { recursive: true }, (_event, file) => {
    if (!file || !/\.(js|html|css)$/.test(file)) return;
    if (!writtenSince(path.join(dist, file), launchedAt)) return;
    scheduleRestart(`${path.join("dist", file).split(path.sep).join("/")} changed`);
  });

  // tsc knows nothing about the html/css, so without this a markup or style edit silently does
  // nothing. The file list stays in copy-assets.js — this re-runs it rather than duplicating it,
  // and the copy lands in dist/, where the watcher above turns it into a restart.
  fs.watch(rendererSrc, (_event, file) => {
    if (!file || !/\.(html|css)$/.test(file)) return;
    // copy-assets *reads* these, which fires this same watcher — without the mtime test each copy
    // would schedule the next one.
    if (!writtenSince(path.join(rendererSrc, file), copiedAt)) return;
    console.log(`[dev] copying renderer assets — src/renderer/${file} changed`);
    copyAssets();
  });

  console.log("[dev] watching src/ — Ctrl+C to stop");
}

// Ctrl+C in a console reaches the children too — they share its process group — but the loop is
// also stopped in ways that don't: a signal sent to this process alone, or the terminal going away.
// `exit` is the sweep for those, and spawnSync inside it is safe because it is synchronous.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (app) treeKill(app);
  treeKill(tsc);
}
process.on("exit", shutdown);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}
