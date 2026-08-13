import type { Session } from "./types";

/**
 * Whether a map is running right now.
 *
 * `endedAt === null` is the whole test, and it is the only one — a session is closed by writing a
 * timestamp into it (`endSession` in `db/store.ts`), so an unclosed session *is* the map in progress.
 *
 * Deliberately says nothing about which zone the player is standing in. A session started by the
 * toggle-session hotkey carries `zoneName: null` and can perfectly well be running while the player
 * is in their hideout, so folding the hideout flag in here would close a map the user opened by hand.
 * That flag refines the *label* for the inactive case — hideout versus atlas — and nothing else.
 *
 * Extracted because three call sites in `main/index.ts` open-coded it, and because the renderer's two
 * header lines disagreed about it: the status line tested `endedAt`, while the running total tested
 * only that a session existed, so the total went on displaying a finished map indefinitely.
 *
 * A type guard rather than a plain boolean, so those call sites keep the null-narrowing they had when
 * the check was written out longhand.
 */
export function isSessionActive(session: Session | null | undefined): session is Session {
  return !!session && session.endedAt === null;
}

/**
 * Whether the player is in a map *right now* — an active session that represents an actual map.
 *
 * The extra condition beyond `isSessionActive` exists because not every session is a map. Capturing
 * an item anywhere — standing in your hideout, sorting a stash — calls `ensureActiveSession`, which
 * opens a session so the item has somewhere to be filed. That session is real and its total is real,
 * but it is not a map, and treating it as one collapsed the whole panel to its in-map form the moment
 * you pressed Ctrl+C in a hideout, until the next zone change closed it.
 *
 * So a session counts as a map when it came from **entering a map zone** (it has a `zoneName`) or
 * from the **toggle-session hotkey** (`manual`), and not when it was opened implicitly by a capture.
 */
export function isMapSession(session: Session | null | undefined): session is Session {
  return isSessionActive(session) && (session.zoneName !== null || session.manual === true);
}
