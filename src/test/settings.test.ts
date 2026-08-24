import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  adoptInstantBuyoutDefault,
  adoptListingThresholdDefault,
  adoptSearchBudgetDefaults,
  foldLegacyProcessName,
  mergeWithDefaults,
  unionPoeNinjaCategories
} from "../main/settings";
import type { Settings } from "../shared/settings";

function makeDefaults(): Settings {
  return {
    league: "Standard",
    setupCompleted: true,
    poe2ProcessNames: ["PathOfExileSteam.exe", "PathOfExile.exe"],
    overlay: {
      hideWhenGameUnfocused: true,
      focusPollIntervalMs: 400,
      hideDelayMs: 500,
      panel: { width: 380, maxHeightPercent: 80, position: "right" as const }
    },
    hotkeys: {
      toggleList: "CommandOrControl+Shift+L",
      forceCapture: "CommandOrControl+`"
    },
    display: {
      currency: "auto"
    },
    updates: {
      checkForUpdates: true,
      checkIntervalMs: 21600000
    },
    poeNinja: {
      baseUrl: "https://poe.ninja/poe2/api/economy",
      refreshIntervalMs: 900000,
      maxConcurrentRequests: 4,
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
      maxSearchesPerLongWindow: 240,
      longWindowMs: 21600000,
      minSearchIntervalMs: 5000,
      searchBudgetMigrated: false,
      saleType: "buyout" as const,
      maxListings: 5,
      listingStatus: "online" as const,
      listingStatusMigrated: false,
      minListingsThresholdMigrated: false,
      useModDropLadder: true,
      maxModDropSearches: 5,
      modDropTierThreshold: 3,
      minListingsForMatch: 10,
      minModMatchRatio: 0.5,
      useDefenceFilters: true,
      useWeaponFilters: true,
      defenceMinRatio: 0.9,
      usePseudoFilters: true,
      pseudoMinRatio: 0.9,
      useMapFilters: true,
      mapMinRatio: 0.9,
      useBaseItemSearch: true,
      baseItemMinLevel: 81,
      minListingPrice: 1,
      maxTransientRetries: 1
    }
  };
}

/**
 * Every leaf key path in an object, `"trade2.maxListings"` style, sorted.
 *
 * Leaves rather than every node, and arrays treated as leaves: `poe2ProcessNames` and
 * `itemOverviewTypes` are values the user edits wholesale, not nested structure to compare.
 */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value) || typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

/**
 * The shipped defaults and this file's fixture must describe the same shape.
 *
 * This is the guard for the repo's most expensive failure mode, and the one the type system cannot
 * see. `mergeWithDefaults` builds its result from the **defaults'** key set, so a key added to the
 * `Settings` type but forgotten in `config/settings.default.json` type-checks perfectly and is
 * `undefined` at runtime — which is the exact situation that function exists to prevent, arriving by
 * the one door it doesn't watch. It fails in the client that reads the key, far from the change.
 *
 * The other direction matters too: a key dropped from the type but left in the defaults file is
 * carried into every user's settings.json forever, since the merge copies whatever the defaults hold.
 *
 * Values are deliberately **not** compared. The fixture is not a copy of the defaults and must not
 * become one — the migration tests below need it holding the *old* shipped values
 * (`listingStatus: "online"`, `minListingsForMatch: 10`) to have anything to migrate.
 */
test("the shipped defaults and the fixture describe the same shape", () => {
  const shipped = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "config", "settings.default.json"), "utf-8")
  );

  const inFixtureOnly = keyPaths(makeDefaults()).filter((k) => !keyPaths(shipped).includes(k));
  const inShippedOnly = keyPaths(shipped).filter((k) => !keyPaths(makeDefaults()).includes(k));

  assert.deepEqual(
    inFixtureOnly,
    [],
    `in the Settings type but missing from config/settings.default.json, so undefined at runtime: ${inFixtureOnly.join(", ")}`
  );
  assert.deepEqual(
    inShippedOnly,
    [],
    `in config/settings.default.json but not in the Settings type, so shipped to users unread: ${inShippedOnly.join(", ")}`
  );
});

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
      toggleList: "CommandOrControl+Shift+X"
      // forceCapture missing, as if written before that field existed. This is the real upgrade
      // path: an install predating a hotkey gains it on the next load without losing the one it set.
    }
  };

  const merged = mergeWithDefaults(defaults, loaded);

  assert.equal(merged.hotkeys.forceCapture, defaults.hotkeys.forceCapture);
  assert.equal(merged.hotkeys.toggleList, "CommandOrControl+Shift+X");
});

test("a key that has left the defaults is dropped rather than carried forever", () => {
  // The other direction of the same rule, and what makes removing a setting safe: `toggleOverlay`
  // was a real hotkey, so every install from before its removal still has it in settings.json.
  // `mergeWithDefaults` builds from the *defaults'* key set, so the stale key never reaches the
  // result and the file loses it the next time it is written. No migration fold is needed for a
  // removal — only for a changed default, which this is not.
  const defaults = makeDefaults();
  const loaded = {
    ...defaults,
    hotkeys: { ...defaults.hotkeys, toggleOverlay: "CommandOrControl+Shift+O" }
  };

  const merged = mergeWithDefaults(defaults, loaded);

  assert.equal("toggleOverlay" in merged.hotkeys, false);
  assert.deepEqual(Object.keys(merged.hotkeys), Object.keys(defaults.hotkeys));
});

test("the shipped panel side is one the renderer knows how to place", () => {
  // Read from the file rather than restated here, as accelerator.test.ts does with the hotkeys:
  // `mergeWithDefaults` hands this string straight through to `OverlayStatus`, and the renderer
  // only ever tests it against "left". A typo would place the panel right while the form read left.
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "config", "settings.default.json"), "utf-8")
  ) as { overlay: { panel: { position: string } } };

  assert.equal(defaults.overlay.panel.position, "right");
});

test("the shipped sale type excludes listings with no asking price", () => {
  // Read from the file for the same reason as the panel side above. This one decides what every
  // install prices against by default: "any" would quietly fold unpriced listings into a median
  // taken over the cheapest matches, which is exactly where they do the most damage.
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "config", "settings.default.json"), "utf-8")
  ) as { trade2: { saleType: string } };

  assert.equal(defaults.trade2.saleType, "buyout");
});

test("fills in the sale type for a settings.json written before it was configurable", () => {
  const defaults = makeDefaults();
  const { saleType, ...trade2WithoutSaleType } = defaults.trade2;
  const loaded = { ...defaults, trade2: trade2WithoutSaleType };

  const merged = mergeWithDefaults(defaults, loaded as typeof defaults);

  // Existing installs land on buyout-only, which is what they were already getting: the app never
  // sent a sale_type filter before this was configurable, and omitting it *is* buyout-only.
  assert.equal(merged.trade2.saleType, "buyout");
});

test("fills in the panel's side for a settings.json written before it was configurable", () => {
  const defaults = makeDefaults();
  const loaded = {
    ...defaults,
    overlay: {
      ...defaults.overlay,
      // Sized by hand, as any existing install may well be, and predating `position` entirely —
      // nothing migrates settings.json, so the merge is the whole upgrade path.
      panel: { width: 520, maxHeightPercent: 60 }
    }
  };

  const merged = mergeWithDefaults(defaults, loaded);

  assert.equal(merged.overlay.panel.position, "right");
  assert.equal(merged.overlay.panel.width, 520);
  assert.equal(merged.overlay.panel.maxHeightPercent, 60);
});

test("the shipped listing status is the one that matches what the price claims to mean", () => {
  // Read from the file for the same reason as the sale type above, and with more riding on it: this
  // is the value `adoptInstantBuyoutDefault` migrates existing installs *to*, so a typo here would
  // rewrite every settings.json to something GGG rejects rather than leaving them alone.
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "config", "settings.default.json"), "utf-8")
  ) as { trade2: { listingStatus: string; listingStatusMigrated: boolean } };

  assert.equal(defaults.trade2.listingStatus, "securable");
  // False as shipped, which is what makes an existing install migrate: `mergeWithDefaults` fills the
  // key in as false and the fold then runs once. A fresh install is already on "securable", so the
  // fold has nothing to rewrite and only stamps the marker.
  assert.equal(defaults.trade2.listingStatusMigrated, false);
});

test("an install still on the old listing status default is moved to instant buyout", () => {
  const settings = makeDefaults();

  const migrated = adoptInstantBuyoutDefault(settings);

  assert.equal(migrated.trade2.listingStatus, "securable");
  assert.equal(migrated.trade2.listingStatusMigrated, true);
});

test("a listing status the user can only have chosen deliberately survives the migration", () => {
  // "online" was the old shipped default and is the one value nobody had to pick. Every other option
  // had to be typed into settings.json by hand, so rewriting one would discard a real decision.
  for (const status of ["any", "available", "onlineleague"] as const) {
    const settings = makeDefaults();
    settings.trade2.listingStatus = status;

    const migrated = adoptInstantBuyoutDefault(settings);

    assert.equal(migrated.trade2.listingStatus, status);
    // Stamped anyway, so the migration is spent and can never revisit this install.
    assert.equal(migrated.trade2.listingStatusMigrated, true);
  }
});

test("an online listing status picked after the migration ran is left alone", () => {
  // The whole reason the marker exists. Now that the settings window can set this, "online" is a
  // choice like any other, and a fold that kept correcting it would make the dropdown silently
  // not work.
  const settings = makeDefaults();
  settings.trade2.listingStatusMigrated = true;

  const migrated = adoptInstantBuyoutDefault(settings);

  assert.equal(migrated.trade2.listingStatus, "online");
  assert.equal(migrated, settings);
});

test("a settings.json predating the marker migrates on the next load", () => {
  // The real upgrade path, and the reason this needs a fold at all: the key is absent entirely, so
  // `mergeWithDefaults` supplies the false that lets the migration fire — but it leaves the stale
  // `listingStatus` exactly as it found it, because that key is present. Composed the way
  // `loadSettings` composes them.
  const defaults = makeDefaults();
  defaults.trade2.listingStatus = "securable";
  const { listingStatusMigrated, ...trade2WithoutMarker } = makeDefaults().trade2;
  const loaded = { ...defaults, trade2: trade2WithoutMarker };

  const merged = mergeWithDefaults(defaults, loaded as typeof defaults);
  assert.equal(merged.trade2.listingStatus, "online");

  const migrated = adoptInstantBuyoutDefault(merged);

  assert.equal(migrated.trade2.listingStatus, "securable");
  assert.equal(migrated.trade2.listingStatusMigrated, true);
});

test("the shipped listing threshold stops at the first rung that matched anything", () => {
  // Read from the file, like the listing status above and for the same reason: this is the value
  // `adoptListingThresholdDefault` migrates existing installs *to*.
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "config", "settings.default.json"), "utf-8")
  ) as { trade2: { minListingsForMatch: number; minListingsThresholdMigrated: boolean } };

  assert.equal(defaults.trade2.minListingsForMatch, 1);
  assert.equal(defaults.trade2.minListingsThresholdMigrated, false);
});

test("an install still on the old listing threshold is moved to the shipped one", () => {
  // 10 was the shipped value until "Drop low-tier mods to find a market" took it to 1. Every
  // settings.json written before that kept 10, and with it a ladder that walked past the rung
  // carrying the item's whole mod set whenever fewer than ten listings had it.
  const settings = makeDefaults();
  const defaults = makeDefaults();
  defaults.trade2.minListingsForMatch = 1;

  const migrated = adoptListingThresholdDefault(settings, defaults);

  assert.equal(migrated.trade2.minListingsForMatch, 1);
  assert.equal(migrated.trade2.minListingsThresholdMigrated, true);
});

test("the fold adopts whatever the defaults file currently says, not a second copy of it", () => {
  // A literal target here would drift the moment the default was retuned, and this fold rewrites
  // every existing install — the one place a stale number does the most damage.
  const settings = makeDefaults();
  const defaults = makeDefaults();
  defaults.trade2.minListingsForMatch = 3;

  assert.equal(adoptListingThresholdDefault(settings, defaults).trade2.minListingsForMatch, 3);
});

test("a listing threshold that isn't the old default is a deliberate value and survives", () => {
  // There is no UI for this key, so 10 is the one number an install can carry without anyone having
  // chosen it. Anything else was typed into settings.json by hand.
  for (const threshold of [1, 3, 5, 25]) {
    const settings = makeDefaults();
    settings.trade2.minListingsForMatch = threshold;
    const defaults = makeDefaults();
    defaults.trade2.minListingsForMatch = 1;

    const migrated = adoptListingThresholdDefault(settings, defaults);

    assert.equal(migrated.trade2.minListingsForMatch, threshold);
    // Stamped anyway, so the migration is spent and can never revisit this install.
    assert.equal(migrated.trade2.minListingsThresholdMigrated, true);
  }
});

test("a threshold of 10 set after the migration ran is left alone", () => {
  // The whole reason the marker exists: once the fold has run, 10 is a choice like any other and a
  // fold that kept correcting it would make that choice silently not work.
  const settings = makeDefaults();
  settings.trade2.minListingsThresholdMigrated = true;
  const defaults = makeDefaults();
  defaults.trade2.minListingsForMatch = 1;

  const migrated = adoptListingThresholdDefault(settings, defaults);

  assert.equal(migrated.trade2.minListingsForMatch, 10);
  assert.equal(migrated, settings);
});

test("a settings.json predating the threshold marker migrates on the next load", () => {
  // The real upgrade path, composed the way `loadSettings` composes it: the marker is absent, so
  // `mergeWithDefaults` supplies the false that lets the fold fire, while leaving the stale
  // `minListingsForMatch` exactly as it found it because that key *is* present.
  const defaults = makeDefaults();
  defaults.trade2.minListingsForMatch = 1;
  const { minListingsThresholdMigrated, ...trade2WithoutMarker } = makeDefaults().trade2;
  const loaded = { ...defaults, trade2: trade2WithoutMarker };

  const merged = mergeWithDefaults(defaults, loaded as typeof defaults);
  assert.equal(merged.trade2.minListingsForMatch, 10, "the stale value survives the merge");

  const migrated = adoptListingThresholdDefault(merged, defaults);

  assert.equal(migrated.trade2.minListingsForMatch, 1);
  assert.equal(migrated.trade2.minListingsThresholdMigrated, true);
});

test("the shipped search budget leaves half of GGG's per-IP buckets spare", () => {
  // Read from the file for the same reason the two folds above do: these are the values
  // `adoptSearchBudgetDefaults` migrates existing installs *to*. The arithmetic is 2 GGG requests per
  // budgeted search, against buckets of 30 per 5 minutes and 600 per 6 hours.
  const defaults = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "config", "settings.default.json"), "utf-8")
  ) as {
    trade2: {
      maxSearchesPerWindow: number;
      maxSearchesPerLongWindow: number;
      minSearchIntervalMs: number;
      searchBudgetMigrated: boolean;
    };
  };

  assert.equal(defaults.trade2.maxSearchesPerWindow, 8, "16 of GGG's 30 per 5 minutes");
  assert.equal(defaults.trade2.maxSearchesPerLongWindow, 160, "320 of GGG's 600 per 6 hours");
  assert.equal(defaults.trade2.minSearchIntervalMs, 15000, "~8 requests a minute against GGG's 15");
  assert.equal(defaults.trade2.searchBudgetMigrated, false);
});

test("an install still on the old shipped search budget is moved to the current one", () => {
  // 12 / 240 / 10s was shipped until the budget was lowered to leave more of the per-IP bucket for
  // whatever else is on the connection. Every settings.json written before that kept the old trio.
  const settings = makeDefaults();
  settings.trade2.maxSearchesPerWindow = 12;
  settings.trade2.maxSearchesPerLongWindow = 240;
  settings.trade2.minSearchIntervalMs = 10000;
  const defaults = makeDefaults();
  defaults.trade2.maxSearchesPerWindow = 8;
  defaults.trade2.maxSearchesPerLongWindow = 160;
  defaults.trade2.minSearchIntervalMs = 15000;

  const migrated = adoptSearchBudgetDefaults(settings, defaults);

  assert.equal(migrated.trade2.maxSearchesPerWindow, 8);
  assert.equal(migrated.trade2.maxSearchesPerLongWindow, 160);
  assert.equal(migrated.trade2.minSearchIntervalMs, 15000);
  assert.equal(migrated.trade2.searchBudgetMigrated, true);
});

test("the budget fold adopts whatever the defaults file currently says, not a second copy of it", () => {
  // Same argument as the threshold fold: a literal target here would drift the moment the budget was
  // retuned again, and this fold rewrites every existing install.
  const settings = makeDefaults();
  settings.trade2.maxSearchesPerWindow = 12;
  settings.trade2.maxSearchesPerLongWindow = 240;
  settings.trade2.minSearchIntervalMs = 10000;
  const defaults = makeDefaults();
  defaults.trade2.maxSearchesPerWindow = 6;
  defaults.trade2.maxSearchesPerLongWindow = 120;
  defaults.trade2.minSearchIntervalMs = 20000;

  const migrated = adoptSearchBudgetDefaults(settings, defaults);

  assert.equal(migrated.trade2.maxSearchesPerWindow, 6);
  assert.equal(migrated.trade2.maxSearchesPerLongWindow, 120);
  assert.equal(migrated.trade2.minSearchIntervalMs, 20000);
});

test("a hand-tuned budget key survives while the ones still on the old default migrate", () => {
  // The three keys are judged one at a time on purpose. None of them has a UI, so the old shipped
  // value is the one an install can carry without anyone having chosen it — but somebody who raised
  // the short window by hand and left the other two alone must keep exactly that.
  const settings = makeDefaults();
  settings.trade2.maxSearchesPerWindow = 20;
  settings.trade2.maxSearchesPerLongWindow = 240;
  settings.trade2.minSearchIntervalMs = 10000;
  const defaults = makeDefaults();
  defaults.trade2.maxSearchesPerWindow = 8;
  defaults.trade2.maxSearchesPerLongWindow = 160;
  defaults.trade2.minSearchIntervalMs = 15000;

  const migrated = adoptSearchBudgetDefaults(settings, defaults);

  assert.equal(migrated.trade2.maxSearchesPerWindow, 20, "a deliberate value is never overridden");
  assert.equal(migrated.trade2.maxSearchesPerLongWindow, 160);
  assert.equal(migrated.trade2.minSearchIntervalMs, 15000);
  // Stamped anyway, so the migration is spent and can never revisit this install.
  assert.equal(migrated.trade2.searchBudgetMigrated, true);
});

test("the old budget set after the migration ran is left alone", () => {
  // Why the marker exists at all: once the fold has run, 12 / 240 / 10s is a choice like any other.
  const settings = makeDefaults();
  settings.trade2.maxSearchesPerWindow = 12;
  settings.trade2.maxSearchesPerLongWindow = 240;
  settings.trade2.minSearchIntervalMs = 10000;
  settings.trade2.searchBudgetMigrated = true;
  const defaults = makeDefaults();
  defaults.trade2.maxSearchesPerWindow = 8;

  const migrated = adoptSearchBudgetDefaults(settings, defaults);

  assert.equal(migrated.trade2.maxSearchesPerWindow, 12);
  assert.equal(migrated, settings);
});

test("a settings.json predating the budget marker migrates on the next load", () => {
  // The real upgrade path, composed the way `loadSettings` composes it: the marker is absent, so
  // `mergeWithDefaults` supplies the false that lets the fold fire, while the stale budget survives
  // the merge untouched because those keys *are* present.
  const defaults = makeDefaults();
  defaults.trade2.maxSearchesPerWindow = 8;
  defaults.trade2.maxSearchesPerLongWindow = 160;
  defaults.trade2.minSearchIntervalMs = 15000;
  const { searchBudgetMigrated, ...trade2WithoutMarker } = makeDefaults().trade2;
  const loaded = {
    ...defaults,
    trade2: {
      ...trade2WithoutMarker,
      maxSearchesPerWindow: 12,
      maxSearchesPerLongWindow: 240,
      minSearchIntervalMs: 10000
    }
  };

  const merged = mergeWithDefaults(defaults, loaded as typeof defaults);
  assert.equal(merged.trade2.maxSearchesPerWindow, 12, "the stale budget survives the merge");

  const migrated = adoptSearchBudgetDefaults(merged, defaults);

  assert.equal(migrated.trade2.maxSearchesPerWindow, 8);
  assert.equal(migrated.trade2.maxSearchesPerLongWindow, 160);
  assert.equal(migrated.trade2.minSearchIntervalMs, 15000);
  assert.equal(migrated.trade2.searchBudgetMigrated, true);
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

test("every shipped hotkey has a full row in the settings window, and no row is orphaned", () => {
  // `settings.ts` builds its recorder/Clear/Reset bindings by querying `[data-hotkey="<name>"]` and
  // friends, then calls `addEventListener` on the result with no null check — so a hotkey named in
  // the defaults but missing from the markup throws on window open, and a row left behind after a
  // key is removed is a control that edits a setting nothing reads. Neither shows up in any other
  // test: the suite never loads that page. Removing `toggleOverlay` had to touch both sides at once,
  // and this is what says so.
  const root = path.join(__dirname, "..", "..");
  const defaults = JSON.parse(
    fs.readFileSync(path.join(root, "config", "settings.default.json"), "utf-8")
  ) as { hotkeys: Record<string, string> };
  const markup = fs.readFileSync(path.join(root, "src", "renderer", "settings.html"), "utf-8");

  const named = (attribute: string): string[] =>
    [...markup.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((m) => m[1]!).sort();

  const shipped = Object.keys(defaults.hotkeys).sort();
  assert.deepEqual(named("data-hotkey"), shipped, "recorder buttons must match the shipped hotkeys");
  assert.deepEqual(named("data-clear"), shipped, "every hotkey needs its Clear button");
  assert.deepEqual(named("data-reset"), shipped, "every hotkey needs its Reset button");
});
