import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

/**
 * Every repo path cited in `CLAUDE.md` or `docs/*.md` must exist.
 *
 * This guards the one failure mode the rest of the suite structurally cannot see: documentation that
 * describes code which has since moved or been deleted. The tests only cover modules they import, and
 * there is no lint, so a stale reference survives indefinitely — and is worse than no reference at
 * all, because it is *confidently* wrong. Three were live when this was written: `CLAUDE.md` called
 * `shared/effective-value.ts` the single source of truth for an item's value when nothing had
 * imported it in months, and `ci.yml` justified `runs-on: windows-latest` by citing a
 * `poe2-install.test.ts` deleted with map detection.
 *
 * It matters more now than it did, because the reference material was split out of `CLAUDE.md` into
 * `docs/` — eight files that are read on demand rather than every session, and so are exactly the
 * kind of thing that rots unnoticed.
 */

/**
 * Only backticked tokens that are unambiguously repo paths are checked: they contain a `/` and start
 * at one of the four top-level source directories.
 *
 * Both halves of that rule earn their place. Without the directory prefix, `loot-cache.json` and
 * `settings.json` fail — they live in `app.getPath("userData")` and are not in the repo at all.
 * Without the `/`, bare filenames like `common.js`, `queue.ts` and `index.html` are ambiguous
 * (there are three `index.ts` files) and the docs use them as prose, not as locations.
 */
const PATH_TOKEN = /`((?:src|config|scripts|\.github)\/[A-Za-z0-9._/-]+)`/g;

// dist/test -> repo root, the same two hops `settings.test.ts` uses to reach config/.
const repoRoot = path.join(__dirname, "..", "..");

function docFiles(): string[] {
  const docsDir = path.join(repoRoot, "docs");
  const docs = fs
    .readdirSync(docsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join("docs", name));
  return ["CLAUDE.md", ...docs];
}

test("the docs cite no path that has moved or been deleted", () => {
  const broken: string[] = [];
  let checked = 0;

  for (const doc of docFiles()) {
    const text = fs.readFileSync(path.join(repoRoot, doc), "utf-8");
    for (const [, cited] of text.matchAll(PATH_TOKEN)) {
      checked += 1;
      // A trailing `/` is a directory reference, e.g. `src/pricing/`; both forms resolve the same way.
      if (!fs.existsSync(path.join(repoRoot, cited))) broken.push(`${doc} -> ${cited}`);
    }
  }

  assert.deepEqual(broken, [], `documented paths that no longer exist:\n  ${broken.join("\n  ")}`);
  // A regex that silently stops matching would pass this test while checking nothing.
  assert.ok(checked > 40, `only ${checked} paths matched — PATH_TOKEN has probably stopped matching`);
});

test("every doc in docs/ is reachable from CLAUDE.md", () => {
  const claude = fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf-8");
  const orphans = docFiles()
    .filter((doc) => doc !== "CLAUDE.md")
    .filter((doc) => !claude.includes(doc.replace(/\\/g, "/")));

  // CLAUDE.md is the only file loaded automatically; a doc it never names is a doc nobody opens.
  assert.deepEqual(orphans, [], `docs/ files not linked from CLAUDE.md: ${orphans.join(", ")}`);
});
