import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isMapSession, isSessionActive } from "../shared/session";
import type { Session } from "../shared/types";

function makeSession(patch: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    league: "Runes of Aldur",
    startedAt: 1_700_000_000_000,
    endedAt: null,
    zoneName: "The Ridge",
    totalChaosValue: 42,
    ...patch
  };
}

describe("isSessionActive", () => {
  test("an unclosed session is the map in progress", () => {
    assert.equal(isSessionActive(makeSession()), true);
  });

  test("a closed session is not active, however much it is worth", () => {
    // The case the header's running total used to get wrong: it tested only that a session existed,
    // so a finished map's final figure stayed on screen as though it were still climbing.
    assert.equal(isSessionActive(makeSession({ endedAt: 1_700_000_060_000, totalChaosValue: 900 })), false);
  });

  test("no session at all is not active", () => {
    assert.equal(isSessionActive(null), false);
    assert.equal(isSessionActive(undefined), false);
  });

  test("a session started by hand is active despite having no zone", () => {
    // The toggle-session hotkey opens one with zoneName: null, typically while the player is standing
    // in their hideout. Nothing about the zone may enter this decision, or that map closes itself.
    assert.equal(isSessionActive(makeSession({ zoneName: null })), true);
  });
});

describe("isMapSession", () => {
  test("a session from entering a map zone is a map", () => {
    assert.equal(isMapSession(makeSession({ zoneName: "The Ridge" })), true);
  });

  test("a session the hotkey opened is a map, despite having no zone", () => {
    assert.equal(isMapSession(makeSession({ zoneName: null, manual: true })), true);
  });

  test("a session opened by a capture outside a map is NOT a map", () => {
    // The regression this exists for: every Ctrl+C calls ensureActiveSession, so pressing it in a
    // hideout opened a zoneName-less session. Reading that as a map collapsed the whole panel to its
    // one-row in-map form until the next zone change closed it.
    assert.equal(isMapSession(makeSession({ zoneName: null })), false);
    assert.equal(isMapSession(makeSession({ zoneName: null, manual: false })), false);
  });

  test("an ended session is never a map, however it started", () => {
    assert.equal(isMapSession(makeSession({ endedAt: 1_700_000_060_000 })), false);
    assert.equal(
      isMapSession(makeSession({ endedAt: 1_700_000_060_000, zoneName: null, manual: true })),
      false
    );
  });

  test("a session persisted before `manual` existed reads as not-manual", () => {
    // Nothing migrates loot-cache.json, so the field is simply absent on older sessions. A zoned one
    // is still a map; a zoneless one is not, which is the safe direction — the full panel.
    const legacy = makeSession({ zoneName: "The Ridge" });
    delete (legacy as { manual?: boolean }).manual;
    assert.equal(isMapSession(legacy), true);

    const legacyManual = makeSession({ zoneName: null });
    delete (legacyManual as { manual?: boolean }).manual;
    assert.equal(isMapSession(legacyManual), false);
  });

  test("no session at all is not a map", () => {
    assert.equal(isMapSession(null), false);
    assert.equal(isMapSession(undefined), false);
  });
});
