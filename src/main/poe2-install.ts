import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * PoE2's Steam app id, confirmed against a live `libraryfolders.vdf` — it appears in the `apps`
 * block of whichever library actually holds the game.
 */
const POE2_STEAM_APP_ID = "2694490";

/** Steam's on-disk folder name for PoE2, and the log the app tails, relative to a library root. */
const STEAM_CLIENT_TXT = path.join("steamapps", "common", "Path of Exile 2", "logs", "Client.txt");

/** Where the standalone (non-Steam) client installs by default. */
const STANDALONE_CLIENT_TXT = path.join("Grinding Gear Games", "Path of Exile 2", "logs", "Client.txt");

export interface SteamLibrary {
  path: string;
  /** App ids Steam records as installed in this library. Empty when the block is absent. */
  appIds: string[];
}

/**
 * Pulls a path value out of `reg query ... /v <name>` output, which prints:
 *
 * ```
 * HKEY_CURRENT_USER\Software\Valve\Steam
 *     SteamPath    REG_SZ    c:/program files (x86)/steam
 * ```
 *
 * The value runs to the end of the line because it can contain spaces, and Steam writes it
 * lowercased with forward slashes — hence the `normalize`. Returns null for the "unable to find the
 * specified registry key" output, which has no `REG_SZ` line at all.
 */
export function parseSteamPathFromRegQuery(stdout: string): string | null {
  const match = /^\s*\S+\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/m.exec(stdout);
  const value = match?.[1]?.trim();
  return value ? path.normalize(value) : null;
}

/**
 * Reads the library roots out of `steamapps/libraryfolders.vdf`, each with the app ids installed
 * there. Scanned with regexes rather than a VDF parser: pulling in a dependency for two key shapes
 * isn't worth it, and the format here is flat — a `"path" "D:\\SteamLibrary"` line followed by an
 * `"apps" { "<id>" "<bytes>" }` block, repeated per library.
 *
 * Everything between one `"path"` and the next belongs to that library, which is what attributes
 * each `apps` block to the right root without tracking brace depth. Backslashes are doubled in the
 * file and unescaped here.
 */
export function parseSteamLibraries(vdf: string): SteamLibrary[] {
  const entries = [...vdf.matchAll(/"path"\s*"([^"]*)"/g)];

  return entries.flatMap((entry, index) => {
    const raw = entry[1];
    if (!raw) return [];

    const start = (entry.index ?? 0) + entry[0].length;
    const end = index + 1 < entries.length ? entries[index + 1].index ?? vdf.length : vdf.length;

    return [{
      path: path.normalize(raw.replace(/\\\\/g, "\\")),
      appIds: appIdsIn(vdf.slice(start, end))
    }];
  });
}

function appIdsIn(section: string): string[] {
  const appsBlock = /"apps"\s*\{([^}]*)\}/.exec(section);
  if (!appsBlock) return [];
  return [...appsBlock[1].matchAll(/"(\d+)"\s*"\d+"/g)].map((match) => match[1]);
}

function regQuery(key: string, valueName: string): Promise<string | null> {
  return new Promise((resolve) => {
    // `execFile` on a Windows built-in, matching how `process-watch.ts` calls tasklist. A single
    // registry read doesn't justify the long-lived PowerShell helper `foreground-watch.ts` needs.
    execFile("reg", ["query", key, "/v", valueName], (error, stdout) => {
      // A missing key is the ordinary case on a machine without Steam, and `reg` exits non-zero for
      // it — not something to log or throw over.
      resolve(error ? null : parseSteamPathFromRegQuery(stdout));
    });
  });
}

async function findSteamRoot(): Promise<string | null> {
  const fromCurrentUser = await regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath");
  if (fromCurrentUser) return fromCurrentUser;

  const fromMachine = await regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath");
  if (fromMachine) return fromMachine;

  const programFiles = process.env["ProgramFiles(x86)"];
  return programFiles ? path.join(programFiles, "Steam") : null;
}

function readLibraries(steamRoot: string): SteamLibrary[] {
  // The root is itself a library, and it's the one that exists even when libraryfolders.vdf doesn't.
  const libraries: SteamLibrary[] = [{ path: steamRoot, appIds: [] }];
  try {
    const vdf = fs.readFileSync(path.join(steamRoot, "steamapps", "libraryfolders.vdf"), "utf-8");
    libraries.push(...parseSteamLibraries(vdf));
  } catch {
    // No vdf (or unreadable): the root alone is still worth probing.
  }
  return libraries;
}

/**
 * Locates PoE2's `Client.txt`, which the app tails for zone transitions to start and end map
 * sessions. Steam installs are found automatically; anything else falls to the setup window's
 * Browse button, which is why every failure here returns null rather than throwing.
 *
 * The app id only *orders* the search — a library claiming to hold PoE2 is probed first, but the
 * file existing on disk is the signal that decides. That way a stale or hand-edited vdf can't
 * veto a real install.
 */
export async function detectClientTxtPath(): Promise<string | null> {
  const steamRoot = await findSteamRoot();

  if (steamRoot) {
    const libraries = readLibraries(steamRoot);
    const ordered = [
      ...libraries.filter((library) => library.appIds.includes(POE2_STEAM_APP_ID)),
      ...libraries.filter((library) => !library.appIds.includes(POE2_STEAM_APP_ID))
    ];

    for (const library of ordered) {
      const candidate = path.join(library.path, STEAM_CLIENT_TXT);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Standalone client, installed outside Steam entirely.
  for (const programFiles of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
    if (!programFiles) continue;
    const candidate = path.join(programFiles, STANDALONE_CLIENT_TXT);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}
