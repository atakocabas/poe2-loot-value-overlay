import assert from "node:assert/strict";
import { test } from "node:test";
import { foldLegacyProcessName, mergeWithDefaults, unionPoeNinjaCategories } from "../main/settings";
import type { Settings } from "../shared/settings";

function makeDefaults(): Settings {
  return {
    league: "Standard",
    clientTxtPath: "C:\\PoE2\\logs\\Client.txt",
    setupCompleted: true,
    poe2ProcessNames: ["PathOfExileSteam.exe", "PathOfExile.exe"],
    logWatch: {
      pollIntervalMs: 1000,
      backfillBytes: 65536,
      debugLogging: false
    },
    overlay: {
      hideWhenGameUnfocused: true,
      focusPollIntervalMs: 400,
      hideDelayMs: 500,
      panel: { width: 380, maxHeightPercent: 80 }
    },
    hotkeys: {
      toggleOverlay: "CommandOrControl+Shift+O",
      toggleSession: "CommandOrControl+Shift+M",
      forceCapture: "CommandOrControl+`"
    },
    display: {
      currency: "auto"
    },
    poeNinja: {
      baseUrl: "https://poe.ninja/poe2/api/economy",
      refreshIntervalMs: 900000,
      itemOverviewTypes: ["UniqueWeapons"],
      exchangeOverviewTypes: ["Currency"]
    },
    currencyExchange: {
      enabled: true,
      baseUrl: "https://web.poecdn.com/api/currency-exchange",
      realm: "poe2",
      lookbackHours: 6,
      maxPagesPerRefresh: 6,
      refreshIntervalMs: 3600000,
      minVolume: 20,
      stalePoeNinjaAfterMs: 3600000,
      leagueOverride: ""
    },
    trade2: {
      enabled: true,
      contactEmail: "someone@example.com",
      maxSearchesPerWindow: 10,
      windowMs: 300000,
      minSearchIntervalMs: 5000,
      maxListings: 10,
      listingStatus: "online" as const,
      maxModLadderSearches: 3,
      minListingsForMatch: 10,
      minModMatchRatio: 0.5,
      useDefenceFilters: true,
      defenceMinRatio: 0.9,
      maxTransientRetries: 1
    }
  };
}

test("fills in a top-level field missing from an older settings.json", () => {
  const defaults = makeDefaults();
  const { poe2ProcessNames, ...loaded } = defaults;

  const merged = mergeWithDefaults(defaults, loaded);

  assert.deepEqual(merged.poe2ProcessNames, defaults.poe2ProcessNames);
});

test("fills in a nested field missing from an older settings.json while keeping its siblings", () => {
  const defaults = makeDefaults();
  const loaded = {
    ...defaults,
    hotkeys: {
      toggleOverlay: "CommandOrControl+Shift+X",
      toggleSession: defaults.hotkeys.toggleSession
      // forceCapture missing, as if written before that field existed
    }
  };

  const merged = mergeWithDefaults(defaults, loaded);

  assert.equal(merged.hotkeys.forceCapture, defaults.hotkeys.forceCapture);
  assert.equal(merged.hotkeys.toggleOverlay, "CommandOrControl+Shift+X");
  assert.equal(merged.hotkeys.toggleSession, defaults.hotkeys.toggleSession);
});

test("preserves a user's customized value instead of overwriting it with the default", () => {
  const defaults = makeDefaults();
  const loaded = { ...defaults, league: "Hardcore Runes of Aldur" };

  const merged = mergeWithDefaults(defaults, loaded);

  assert.equal(merged.league, "Hardcore Runes of Aldur");
});

test("a legacy poe2ProcessName string is folded into poe2ProcessNames, taking priority", () => {
  const defaults = makeDefaults();
  const loaded = { ...defaults, poe2ProcessName: "PathOfExilePortable.exe" };

  const folded = foldLegacyProcessName(mergeWithDefaults(defaults, loaded), loaded);

  assert.deepEqual(folded.poe2ProcessNames, ["PathOfExilePortable.exe", "PathOfExileSteam.exe", "PathOfExile.exe"]);
});

test("a legacy poe2ProcessName already covered by the defaults is not duplicated", () => {
  const defaults = makeDefaults();
  const loaded = { ...defaults, poe2ProcessName: "pathofexilesteam.exe" };

  const folded = foldLegacyProcessName(mergeWithDefaults(defaults, loaded), loaded);

  assert.deepEqual(folded.poe2ProcessNames, defaults.poe2ProcessNames);
});

test("a settings.json from the OAuth era gains the new trade2 keys and drops the dead ones", () => {
  const defaults = makeDefaults();
  // Exactly what an install written before trade2 went unauthenticated has on disk.
  const loaded = {
    ...defaults,
    trade2: { clientId: "", redirectPort: 42069, contactEmail: "me@example.com" }
  };

  const merged = mergeWithDefaults(defaults, loaded) as Settings & { trade2: Record<string, unknown> };

  // Without these the client reads `undefined` budgets and every rare lookup is either skipped or
  // unthrottled — the failure mode mergeWithDefaults exists to prevent.
  assert.equal(merged.trade2.enabled, true);
  assert.equal(merged.trade2.maxSearchesPerWindow, 10);
  assert.equal(merged.trade2.windowMs, 300000);
  assert.equal(merged.trade2.contactEmail, "me@example.com", "the user's own value must survive");
  assert.equal(merged.trade2.clientId, undefined, "keys no longer in the schema are not carried over");
});

test("a settings.json predating a new poe.ninja category still picks it up", () => {
  const defaults = makeDefaults();
  // An older install: mergeWithDefaults treats arrays as leaves, so this list wins outright and
  // the newly added categories would never be fetched.
  const loaded = {
    ...defaults,
    poeNinja: { ...defaults.poeNinja, exchangeOverviewTypes: ["Currency"], itemOverviewTypes: [] }
  };
  defaults.poeNinja.exchangeOverviewTypes = ["Currency", "UncutGems", "Delirium"];
  defaults.poeNinja.itemOverviewTypes = ["UniqueWeapons"];

  const merged = unionPoeNinjaCategories(mergeWithDefaults(defaults, loaded), defaults);

  assert.deepEqual(merged.poeNinja.exchangeOverviewTypes, ["Currency", "UncutGems", "Delirium"]);
  assert.deepEqual(merged.poeNinja.itemOverviewTypes, ["UniqueWeapons"]);
});

test("a category the user added by hand survives the union, without duplicates", () => {
  const defaults = makeDefaults();
  const loaded = {
    ...defaults,
    poeNinja: { ...defaults.poeNinja, exchangeOverviewTypes: ["Currency", "SomeNewCategory"] }
  };

  const merged = unionPoeNinjaCategories(mergeWithDefaults(defaults, loaded), defaults);

  assert.deepEqual(merged.poeNinja.exchangeOverviewTypes, ["Currency", "SomeNewCategory"]);
});
