import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * The user's own `POESESSID`, encrypted at rest.
 *
 * This is the one credential the app holds, and it is not a scoped API token: a POESESSID
 * authenticates as the user across the whole of pathofexile.com, not merely for stash reads. Three
 * rules follow from that, and none of them is tidiness:
 *
 * - **It is never written to `settings.json`.** That file is public in shape, is rewritten wholesale
 *   by `mergeWithDefaults` on every load, ships a committed default, and is the first thing anyone
 *   pastes into a bug report. A session cookie in it would leak by the ordinary operation of the app.
 * - **It is never returned to a renderer.** `GET_STASH_STATE` reports `hasSessionId()` — a boolean —
 *   and nothing else. A value that crosses the context bridge is a value in a devtools console.
 * - **It is never logged.** Not at debug level, not in an error path, not folded into a URL. The
 *   stash client builds it into a `Cookie` header and nowhere else.
 *
 * Its own file rather than a slice of `loot-cache.json`, so that `clearHistory()` and `saveSettings()`
 * are structurally incapable of touching it in either direction — the store rewrites its whole file on
 * every mutation, and so does the settings module.
 */
const CREDENTIAL_FILE = "stash-credential.bin";

function credentialPath(): string {
  return path.join(app.getPath("userData"), CREDENTIAL_FILE);
}

/**
 * Whether the OS can encrypt for us at all — DPAPI on Windows, the keychain on macOS, and on Linux a
 * keyring that may genuinely be absent on a headless box.
 *
 * The caller is expected to check this *before* offering the user a field to type into, so the
 * refusal below is a backstop rather than the normal way this is discovered.
 */
export function isVaultAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/**
 * **There is deliberately no plaintext fallback.** Writing the cookie unencrypted when the keyring is
 * missing would quietly produce exactly the artefact this module exists to prevent, on precisely the
 * machines least able to protect it. Refusing is the honest outcome: the stash feature is optional and
 * the rest of the app is unaffected by its absence.
 */
export function setSessionId(raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty session id");
  if (!isVaultAvailable()) {
    throw new Error(
      "This machine has no OS credential store available, so the session id can't be stored safely."
    );
  }

  fs.writeFileSync(credentialPath(), safeStorage.encryptString(trimmed));
}

/**
 * Null covers three ordinary cases that are not worth distinguishing to the caller: never set,
 * deleted behind our back, or undecryptable because the file was copied from another machine or user
 * account (DPAPI is scoped to both). All three mean the same thing downstream — ask for it again.
 */
export function getSessionId(): string | null {
  const file = credentialPath();
  if (!fs.existsSync(file)) return null;

  try {
    const decrypted = safeStorage.decryptString(fs.readFileSync(file)).trim();
    return decrypted || null;
  } catch {
    // Deliberately no error detail in the log line: the failure is uninteresting and the surrounding
    // context is a credential.
    console.warn("[stash] stored session id could not be decrypted — treating it as unset");
    return null;
  }
}

export function clearSessionId(): void {
  const file = credentialPath();
  if (fs.existsSync(file)) fs.rmSync(file);
}

/** The only thing about the credential that may cross IPC. */
export function hasSessionId(): boolean {
  return getSessionId() !== null;
}
