import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
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
    foldLegacyProcessName(mergeWithDefaults(defaults, loaded), loaded),
    defaults
  );
  fs.writeFileSync(userPath, JSON.stringify(cachedSettings, null, 2));
  return cachedSettings;
}

export function saveSettings(settings: Settings): void {
  cachedSettings = settings;
  fs.writeFileSync(userSettingsPath(), JSON.stringify(settings, null, 2));
}
