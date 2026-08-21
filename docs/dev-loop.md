# Build, dev loop, CI and releases

How this project is compiled, watched, tested, packaged and released. Read before touching
`scripts/dev.js`, `package.json`'s scripts, or either workflow in `.github/workflows/`.

Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---


```bash
npm run build     # tsc compile (src -> dist) + copy renderer assets (scripts/copy-assets.js)
npm run dev       # build, run, and restart the app on every change — the iterative loop
npm run watch     # tsc --watch alone: type-checking with no rebuild or restart loop
npm test          # npm run build && node --test dist/test/*.test.js
npm start         # npm run build && electron .
npm run package   # npm run build && electron-builder --win --publish=never -> release/
```

`npm run dev` (`scripts/dev.js`) is the loop to reach for: one full build, then `tsc --watch`
alongside a watcher on `src/renderer/*.html|css` that re-runs `copy-assets.js` — tsc knows nothing
about those files, so without it a markup or style edit silently does nothing. A change under `dist/`
restarts Electron wholesale, debounced so one emit is one restart. Four things there are
load-bearing, three of them about *this* app and one about watching files on Windows at all:

- **The respawn waits for the old process's `exit`.** `index.ts` takes
  `app.requestSingleInstanceLock()`, so a replacement spawned while the old copy is still shutting
  down loses the lock and quits immediately — which reads as the app vanishing, not restarting.
- **The kill is `taskkill /T`, not `child.kill()`.** `ForegroundWatcher` spawns its PowerShell helper
  as an ordinary non-detached child and stops it from `will-quit`; Node's kill is `TerminateProcess`,
  which runs no `will-quit` and leaves children behind, so a plain kill orphans one polling
  PowerShell per restart.
- **The watch runs `--noEmitOnError`**, unlike `npm run build`. A compile error then emits nothing,
  `dist/` keeps the last good build, and the running app stays up instead of being restarted into
  half-typed code. It is also what gates the first launch: nothing starts, and nothing watches
  `dist/`, until tsc's own opening full emit has landed — an app started before it is restarted by
  it a second later.
- **Every watch event is checked against the file's mtime.** libuv subscribes to
  `FILE_NOTIFY_CHANGE_LAST_ACCESS` among others, so *reading* a file fires `fs.watch` — and the app
  reads `dist/renderer/*.html|css` on every launch, which was measured restarting it a second time
  for a file nothing had written. `copy-assets` reads the sources for the same reason. Without the
  mtime test each restart arms the next one; it only *looked* stable because NTFS updates access
  times at most hourly.

There is no test filtering flag wired up; to run a single test file, build first then invoke node's
test runner directly against the compiled output, e.g.:
```bash
npm run build && node --test dist/test/store.test.js
```
Tests live in `src/test/*.test.ts` and run against compiled JS in `dist/test/`, using Node's
built-in `node:test` runner (not Jest/Vitest) — `describe`/`test`/`assert` from `node:test` and
`node:assert`.

**Renderer functions are testable despite exporting nothing**, which `item-groups.test.ts` is the
pattern for: it reads `dist/renderer/common.js`, runs it as a script in a `node:vm` context with a
stub `document` (that file's one top-level DOM read is `#item-tooltip`), and picks the function off
the context's global — which is how the page itself gets it. Use this rather than moving renderer
logic into `shared/` to make it importable: the plain-`<script>` constraint below is why it lives
there, and a second copy in `shared/` would drift from the one the panel actually runs.

Packaging on Windows requires Developer Mode enabled (electron-builder's `winCodeSign` step needs
symlink privileges); if it fails with a symlink/privilege error, that's the cause. The hosted Windows
runner in CI has those privileges, so this is a local-only obstacle.

`.github/workflows/ci.yml` runs `npm test` (which compiles first, so it covers type errors too) on
every PR into `main` and on `main` itself. The push half is **not** redundant with the release
workflow below: that one skips its whole body, tests included, whenever the version has already been
released — the common case — so without it a merge that doesn't bump the version would run nothing.
Both workflows are on `windows-latest`, because `settings.test.ts` asserts against Windows paths that
the code under test builds with `path.join`.

**Releases are cut by bumping the version, not by merging.** `.github/workflows/release.yml` runs on
every push to `main`, but its first step asks GitHub whether `v{package.json version}` has already
been released and stops there if it has — so ordinary merges pass through silently, and a merge that
changes the version runs `npm ci && npm test && npm run package` and publishes the NSIS installer and
the portable exe to a new release. The gate is deliberately "is this version released" rather than
"did this commit change package.json": it reads the same from a squashed merge, a re-run or a manual
`workflow_dispatch`. `gh release create` makes the tag itself, so there is no separate tagging step
that could disagree with it. Bump `package.json` **and** `package-lock.json` together (`npm version
<v> --no-git-tag-version`, which touches both — but check its diff, it reformats the `build` block).
