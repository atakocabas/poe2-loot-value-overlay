import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { normalizeAccelerator } from "../shared/accelerator";
import type { Settings } from "../shared/settings";

let cachedSettings: Settings | null = null;

function userSettingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function defaultSettingsPath(): string {
  return path.join(__dirname, "..", "..", "config", "settings.default.json");
}

/**
 * Fills in any key present in `defaults` but missing from `loaded` (recursively for nested
 * objects), so an existing settings.json written before a field was added to the schema doesn't
 * end up with `undefined` values at runtime. Arrays and primitives are treated as leaves: the
 * loaded value wins if present, otherwise the default is used.
 */
export function mergeWithDefaults<T>(defaults: T, loaded: unknown): T {
  if (Array.isArray(defaults) || typeof defaults !== "object" || defaults === null) {
    return loaded !== undefined ? (loaded as T) : defaults;
  }
  const defaultsObj = defaults as Record<string, unknown>;
  const loadedObj = typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
  const result: Record<string, unknown> = { ...defaultsObj };
  for (const key of Object.keys(defaultsObj)) {
    result[key] = mergeWithDefaults(defaultsObj[key], loadedObj[key]);
  }
  return result as T;
}

/**
 * Folds a legacy `poe2ProcessName` string (the setting `poe2ProcessNames` replaced) into the list,
 * so an install that customised it doesn't silently lose that value when the key is renamed.
 * `mergeWithDefaults` only carries over keys present in the defaults, so this has to be explicit.
 */
export function foldLegacyProcessName(settings: Settings, loaded: unknown): Settings {
  const legacy = typeof loaded === "object" && loaded !== null
    ? (loaded as Record<string, unknown>).poe2ProcessName
    : undefined;
  if (typeof legacy !== "string" || !legacy.trim()) return settings;

  const known = settings.poe2ProcessNames.map((name) => name.toLowerCase());
  if (known.includes(legacy.toLowerCase())) return settings;
  return { ...settings, poe2ProcessNames: [legacy, ...settings.poe2ProcessNames] };
}

/**
 * Takes an install still carrying the old shipped `listingStatus` default to the new one, once.
 *
 * `mergeWithDefaults` only fills in keys that are *missing*, so changing a default in
 * `settings.default.json` reaches new installs and nobody else. When the default moved from
 * `"online"` (GGG's *In Person (Online)*) to `"securable"` (*Instant Buyout*), every existing
 * settings.json went on searching in-person listings — which is invisible: the app quietly prices
 * against listings you cannot buy on demand, and "View search" faithfully reopens that same query,
 * so the site agrees with the app and neither says anything is wrong.
 *
 * Only an exact `"online"` is rewritten. That was the old default, so it is the one value a user
 * cannot have arrived at by choosing it from a dropdown that did not exist yet; `"any"`,
 * `"available"` and `"onlineleague"` could only have been typed deliberately and are left alone.
 * The marker is stamped either way, so this runs exactly once and a deliberate `"online"` picked in
 * the settings window afterwards is never overridden.
 */
export function adoptInstantBuyoutDefault(settings: Settings): Settings {
  if (settings.trade2.listingStatusMigrated) return settings;
  return {
    ...settings,
    trade2: {
      ...settings.trade2,
      listingStatus: settings.trade2.listingStatus === "online" ? "securable" : settings.trade2.listingStatus,
      listingStatusMigrated: true
    }
  };
}

/**
 * The old shipped `minListingsForMatch`. See `adoptListingThresholdDefault`.
 *
 * A literal rather than a lookup into git history, obviously — but it is the *only* value that fold
 * may touch, so it is named here rather than buried in the condition.
 */
const LEGACY_LISTING_THRESHOLD = 10;

/**
 * Takes an install still carrying the old shipped `minListingsForMatch` to the current one, once.
 *
 * Same failure as `adoptInstantBuyoutDefault` above and, unlike that one, this default really did
 * change under existing installs: `settings.default.json` shipped **10** until "Drop low-tier mods to
 * find a market", which took it to **1**. `mergeWithDefaults` only fills in keys that are *missing*,
 * so every settings.json written before that commit still holds 10 and always would.
 *
 * What that costs is not subtle. The ladder walks past the rung carrying the item's **whole** mod set
 * whenever fewer than 10 listings have it, and prices off a looser rung instead — a real four-mod
 * Sapphire had 9 listings at all four mods and was priced at 0.12 chaos off 147 listings sharing
 * three, while the four-mod market started at 4 divine. It reported this correctly and looked, from
 * the outside, exactly like a search that had failed to find listings that plainly existed.
 *
 * Only an exact 10 is rewritten: there is no UI for this key, so 10 is the one value an install can
 * be carrying without anyone having chosen it. The marker is stamped either way, so a deliberate 10
 * hand-edited afterwards is never overridden — the same reasoning that makes the fold above safe to
 * keep. The target comes from `defaults` rather than a second literal, so it cannot drift from the
 * file it exists to adopt.
 */
export function adoptListingThresholdDefault(settings: Settings, defaults: Settings): Settings {
  if (settings.trade2.minListingsThresholdMigrated) return settings;
  return {
    ...settings,
    trade2: {
      ...settings.trade2,
      minListingsForMatch:
        settings.trade2.minListingsForMatch === LEGACY_LISTING_THRESHOLD
          ? defaults.trade2.minListingsForMatch
          : settings.trade2.minListingsForMatch,
      minListingsThresholdMigrated: true
    }
  };
}

/**
 * The old shipped trade2 search budget. See `adoptSearchBudgetDefaults`.
 *
 * Literals rather than a lookup into git history, and named here for the same reason
 * `LEGACY_LISTING_THRESHOLD` is: they are the only values that fold may touch.
 */
const LEGACY_SEARCH_BUDGET = {
  maxSearchesPerWindow: 12,
  maxSearchesPerLongWindow: 240,
  minSearchIntervalMs: 10000
} as const;

/**
 * Takes an install still carrying the old shipped trade2 search budget to the current one, once.
 *
 * The third fold of this shape, for the reason the two above already give: `mergeWithDefaults` fills
 * in *missing* keys only, so lowering the shipped budget from 12 searches per 5 minutes / 240 per 6
 * hours / 10s spacing to 8 / 160 / 15s reached new installs and nobody else. What that leaves behind
 * is invisible from inside the app — an existing settings.json goes on spending four fifths of GGG's
 * per-IP buckets, every lookup succeeds, and nothing looks wrong until another trade tool on the
 * same connection tips a bucket over and the whole IP is locked out for half an hour.
 *
 * Each key is rewritten only when it holds exactly its own old shipped value, and independently of
 * the other two: none of the three has a UI, so the shipped value is the one an install can be
 * carrying without anyone having chosen it, and someone who hand-tuned one of them keeps it while
 * the rest still migrate. The targets come from `defaults` rather than a second set of literals, so
 * the fold cannot drift from the file it exists to adopt, and the marker is stamped either way so
 * this runs exactly once.
 */
export function adoptSearchBudgetDefaults(settings: Settings, defaults: Settings): Settings {
  if (settings.trade2.searchBudgetMigrated) return settings;

  const adopt = (key: keyof typeof LEGACY_SEARCH_BUDGET): number =>
    settings.trade2[key] === LEGACY_SEARCH_BUDGET[key] ? defaults.trade2[key] : settings.trade2[key];

  return {
    ...settings,
    trade2: {
      ...settings.trade2,
      maxSearchesPerWindow: adopt("maxSearchesPerWindow"),
      maxSearchesPerLongWindow: adopt("maxSearchesPerLongWindow"),
      minSearchIntervalMs: adopt("minSearchIntervalMs"),
      searchBudgetMigrated: true
    }
  };
}

/**
 * The old shipped `hotkeys.toggleList`. See `adoptToggleListDefault`.
 *
 * A literal, named here rather than buried in the condition, for the reason
 * `LEGACY_LISTING_THRESHOLD` is: it is the only value that fold may touch.
 */
const LEGACY_TOGGLE_LIST = "CommandOrControl+Shift+L";

/**
 * Takes an install still carrying the old shipped `toggleList` combination to the current one, once.
 *
 * The fourth fold of this shape, and the first outside `trade2`. `mergeWithDefaults` fills in
 * *missing* keys only, so moving the shipped binding from Ctrl+Shift+L to Ctrl+Space reaches new
 * installs and nobody else — leaving the README, the docs and the settings window all describing a
 * key that does nothing on most machines, with no way for the user to tell which of the two they
 * have short of opening settings.json.
 *
 * **Compared through `normalizeAccelerator` rather than by string equality**, which is a slightly
 * wider net than the three folds above cast and deliberately so. `Control+Shift+L` and
 * `CommandOrControl+Shift+L` are one combination on Windows — that is exactly what the modifier
 * aliases exist for — and the recorder writes one spelling while a settings.json edited by hand may
 * hold the other. Migrating one and not the other would split users on a difference neither of them
 * can see.
 *
 * The marker is stamped either way, so this runs exactly once and a Ctrl+Shift+L chosen deliberately
 * afterwards is never overridden. The target comes from `defaults` rather than a second literal, so
 * the fold cannot drift from the file it exists to adopt.
 */
export function adoptToggleListDefault(settings: Settings, defaults: Settings): Settings {
  if (settings.toggleListDefaultMigrated) return settings;

  const isLegacy =
    normalizeAccelerator(settings.hotkeys.toggleList) === normalizeAccelerator(LEGACY_TOGGLE_LIST);

  return {
    ...settings,
    hotkeys: {
      ...settings.hotkeys,
      toggleList: isLegacy ? defaults.hotkeys.toggleList : settings.hotkeys.toggleList
    },
    toggleListDefaultMigrated: true
  };
}

/**
 * Unions the poe.ninja category lists with the defaults. `mergeWithDefaults` treats arrays as
 * leaves, so an install whose settings.json predates a newly added category would never fetch it
 * and every item in that category would stay silently unpriced — the same failure mode that hid
 * omens for a whole league. Categories a user added by hand are kept.
 *
 * The cost of a category the user didn't want is one request per refresh; the cost of a missing
 * one is invisible. Hence union rather than "loaded wins".
 */
export function unionPoeNinjaCategories(settings: Settings, defaults: Settings): Settings {
  const union = (loaded: string[], fallback: string[]): string[] => [...new Set([...loaded, ...fallback])];
  return {
    ...settings,
    poeNinja: {
      ...settings.poeNinja,
      itemOverviewTypes: union(settings.poeNinja.itemOverviewTypes, defaults.poeNinja.itemOverviewTypes),
      exchangeOverviewTypes: union(
        settings.poeNinja.exchangeOverviewTypes,
        defaults.poeNinja.exchangeOverviewTypes
      )
    }
  };
}

/**
 * The values as shipped, ignoring whatever the user has saved. Read fresh each call rather than
 * cached — it is only asked for when the settings window opens, and a stale copy of the file the
 * merge is built from would be a confusing thing to hold onto.
 *
 * This is what the settings window's per-field Reset buttons restore to, so "default" there means
 * the same thing it means to `mergeWithDefaults`, rather than a second set of constants over in the
 * renderer that would drift the first time one is retuned.
 */
export function loadDefaultSettings(): Settings {
  return JSON.parse(fs.readFileSync(defaultSettingsPath(), "utf-8")) as Settings;
}

export function loadSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  const userPath = userSettingsPath();
  if (!fs.existsSync(userPath)) {
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.copyFileSync(defaultSettingsPath(), userPath);
  }

  const defaults = JSON.parse(fs.readFileSync(defaultSettingsPath(), "utf-8")) as Settings;
  const loaded = JSON.parse(fs.readFileSync(userPath, "utf-8")) as unknown;
  cachedSettings = unionPoeNinjaCategories(
    adoptToggleListDefault(
      adoptSearchBudgetDefaults(
        adoptListingThresholdDefault(
          adoptInstantBuyoutDefault(
            foldLegacyProcessName(mergeWithDefaults(defaults, loaded), loaded)
          ),
          defaults
        ),
        defaults
      ),
      defaults
    ),
    defaults
  );
  fs.writeFileSync(userPath, JSON.stringify(cachedSettings, null, 2));
  // Which file the values came from, once per process. Every knob printed at boot is read from here,
  // and more than one settings.json can exist on a machine — an unpackaged run and a packaged one
  // resolve `app.getPath("userData")` differently — so "the settings say X" is not a checkable claim
  // without the path beside it. It cost an afternoon of guessing once.
  console.log(`[settings] loaded ${userPath}`);
  return cachedSettings;
}

export function saveSettings(settings: Settings): void {
  cachedSettings = settings;
  fs.writeFileSync(userSettingsPath(), JSON.stringify(settings, null, 2));
}
