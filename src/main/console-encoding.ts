/**
 * Windows consoles run on a legacy OEM codepage (437/850 in most locales), not UTF-8, while Node
 * writes UTF-8 bytes. Any non-ASCII character in a log line therefore arrives as mojibake — an em
 * dash prints as `ΓÇö`:
 *
 *     [pricing] "Torment Knuckle" unpriced ΓÇö trade2 search returned HTTP 502
 *
 * which lands on precisely the diagnostic messages someone reads when something has gone wrong.
 *
 * Rewriting today's log strings to ASCII would fix it until the next one is written, so the
 * substitution happens once at the console boundary instead.
 *
 * This used to touch only typographic punctuation, on the assumption that item and zone names are
 * ASCII in PoE2. They are not — "Oisín's Oath" printed as `Ois├¡n's Oath` — so accented letters are
 * folded as well, which is the one class of non-ASCII that has an obvious ASCII reading.
 */
const SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[—–]/g, "-"], // em dash, en dash
  [/[‘’]/g, "'"], // curly single quotes
  [/[“”]/g, '"'], // curly double quotes
  [/…/g, "..."],
  [/→/g, "->"],
  // Built from the code point rather than typed: an invisible character in a regex literal reads
  // as a plain space, and one editing pass flattened it into a space-for-space no-op that quietly
  // let the nbsp fall through to the "?" below.
  [new RegExp(String.fromCharCode(0xa0), "g"), " "] // non-breaking space
];

/** What NFD decomposes an accent into, so stripping these leaves the plain letter behind. */
const COMBINING_MARKS = /\p{Mn}/gu;

/** Replaces typographic characters and accented letters a legacy Windows codepage can't render. */
export function asciiSafe(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SUBSTITUTIONS) result = result.replace(pattern, replacement);

  // NFD splits "í" into "i" plus a combining acute, so dropping the marks leaves the letter behind.
  // Whatever has no ASCII form at all (an undecomposable "ø", CJK, an emoji) becomes a single "?"
  // rather than the run of mojibake bytes that makes a log line look corrupted rather than foreign.
  return result
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/[^\x00-\x7f]/g, "?");
}

/**
 * Wraps the console so every log line is codepage-safe. No-op off Windows, where the terminal is
 * UTF-8 and the original characters render correctly.
 */
export function useAsciiConsoleOnWindows(): void {
  if (process.platform !== "win32") return;

  for (const method of ["log", "warn", "error", "info", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) =>
      original(...args.map((arg) => (typeof arg === "string" ? asciiSafe(arg) : arg)));
  }
}
