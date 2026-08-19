/*
 * Semantic-version comparison for the release check — `main/update-check.ts` is its only consumer.
 *
 * Pure and shared for the same reason `accelerator.ts` is: it is the one part of the update check
 * with an answer that can be asserted without a network, and getting it wrong is silent in both
 * directions. Reporting an update that isn't there sends users to download what they already run;
 * missing one leaves the feature doing nothing at all, which looks exactly like a working install.
 */

interface ParsedVersion {
  /** Numeric segments, left to right. Missing trailing segments are filled with 0 by the comparison. */
  segments: number[];
  /**
   * The `-rc.1` tail, or "" for a plain release.
   *
   * Kept as text and compared only for presence: this app tags releases `v0.2.0` and has never cut a
   * prerelease, so ordering two prereleases against each other is a rule with no caller. What does
   * matter is that `1.0.0-rc.1` never reads as newer than `1.0.0`.
   */
  prerelease: string;
}

/**
 * Splits `v1.2.3-rc.1` into its parts, or returns null for anything that isn't a version.
 *
 * The leading `v` is tolerated because that is the shape of the tag: `.github/workflows/release.yml`
 * creates `v{package.json version}`, while `app.getVersion()` returns the bare number — so the two
 * sides of every comparison are spelled differently by construction.
 */
function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim());
  if (!match) return null;
  return {
    segments: match[1].split(".").map((part) => Number(part)),
    prerelease: match[2] ?? ""
  };
}

/**
 * Whether `candidate` is a strictly newer release than `current`.
 *
 * **Unparseable input answers false**, which is the whole point of returning a boolean rather than a
 * comparison: a GitHub tag this doesn't understand must leave the app quiet rather than inventing an
 * update out of a string it couldn't read. The check runs unattended every six hours, so a false
 * positive would be permanent and unexplained.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;

  const length = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < length; i++) {
    // A missing segment reads as 0, so `1.2` and `1.2.0` are the same release.
    const left = a.segments[i] ?? 0;
    const right = b.segments[i] ?? 0;
    if (left !== right) return left > right;
  }

  // Same numbers: a prerelease sits below the release it precedes, and above nothing else.
  if (a.prerelease === b.prerelease) return false;
  return a.prerelease === "";
}
