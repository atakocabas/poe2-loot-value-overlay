/*
 * Validation for Electron accelerator strings — the `hotkeys.*` values in settings.json.
 *
 * Pure and shared because the settings window has to reject a bad combo *before* it reaches
 * `globalShortcut.register`, which reports refusal by returning false rather than throwing and so
 * can't distinguish "Windows owns this" from "that isn't a key name at all". Those are different
 * messages to show the user, and only one of them is worth retrying.
 */

/**
 * Modifier spellings Electron accepts, folded to a canonical name. Windows readings: `CommandOrControl`
 * *is* Control here, and `Super`/`Meta` is the Windows key. Folding them matters for duplicate
 * detection — `Control+O` and `CommandOrControl+O` are one combo on this platform, and binding both
 * would leave the second silently unregistered.
 */
const MODIFIER_ALIASES: Record<string, string> = {
  command: "ctrl",
  cmd: "ctrl",
  commandorcontrol: "ctrl",
  cmdorctrl: "ctrl",
  control: "ctrl",
  ctrl: "ctrl",
  alt: "alt",
  option: "alt",
  altgr: "altgr",
  shift: "shift",
  super: "super",
  meta: "super"
};

/** Canonical modifier order, so two spellings of one combo normalise to the same string. */
const MODIFIER_ORDER = ["ctrl", "alt", "altgr", "shift", "super"];

/** Electron's named keys. Single characters and F-keys are handled separately, below. */
const NAMED_KEYS = new Set([
  "plus",
  "space",
  "tab",
  "capslock",
  "numlock",
  "scrolllock",
  "backspace",
  "delete",
  "insert",
  "return",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "escape",
  "esc",
  "printscreen",
  "volumeup",
  "volumedown",
  "volumemute",
  "medianexttrack",
  "mediaprevioustrack",
  "mediastop",
  "mediaplaypause",
  "numdec",
  "numadd",
  "numsub",
  "nummult",
  "numdiv"
]);

/** Punctuation Electron takes as a bare single character. */
const PUNCTUATION = new Set([
  "~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "-", "_", "=", "+",
  "[", "]", "{", "}", "\\", "|", ";", ":", "'", "\"", ",", ".", "<", ">", "/", "?", "`"
]);

function isKeyToken(token: string): boolean {
  const lower = token.toLowerCase();
  if (NAMED_KEYS.has(lower)) return true;
  if (/^f([1-9]|1\d|2[0-4])$/.test(lower)) return true;
  if (/^num[0-9]$/.test(lower)) return true;
  if (token.length === 1) return /[a-z0-9]/i.test(token) || PUNCTUATION.has(token);
  return false;
}

/**
 * Human-readable reason the accelerator is unusable, or null if it's fine.
 *
 * An empty string is **valid and means disabled** — that is what the settings window's Clear button
 * writes, and `registerHotkeys` skips it rather than binding anything.
 */
export function validateAccelerator(accelerator: string): string | null {
  if (accelerator === "") return null;

  const tokens = accelerator.split("+");
  if (tokens.some((token) => token === "")) {
    return "That doesn't look like a key combination.";
  }

  const modifiers: string[] = [];
  const keys: string[] = [];
  for (const token of tokens) {
    const asModifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (asModifier) modifiers.push(asModifier);
    else keys.push(token);
  }

  if (keys.length === 0) {
    return "Needs a key, not just modifiers.";
  }
  if (keys.length > 1) {
    return `Only one key at a time — this has ${keys.length}.`;
  }
  if (!isKeyToken(keys[0])) {
    return `"${keys[0]}" isn't a key Electron recognises.`;
  }
  // A global shortcut is taken from every application, so a bare key would swallow that letter
  // system-wide — including from PoE2's own chat box. Never what the user meant.
  if (modifiers.length === 0) {
    return "Needs at least one modifier (Ctrl, Alt or Shift).";
  }

  return null;
}

/**
 * One combo written two ways, reduced to a single comparable string. Only useful for comparison —
 * it is not a spelling Electron accepts back.
 */
export function normalizeAccelerator(accelerator: string): string {
  const tokens = accelerator.split("+");
  const modifiers = new Set<string>();
  const keys: string[] = [];

  for (const token of tokens) {
    const asModifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (asModifier) modifiers.add(asModifier);
    else keys.push(token.toLowerCase());
  }

  return [...MODIFIER_ORDER.filter((name) => modifiers.has(name)), ...keys].join("+");
}

/**
 * Names of hotkeys bound to a combo some other hotkey already has.
 *
 * Worth catching up front: `globalShortcut.register` refuses the second binding of one combo exactly
 * as it refuses a combo another app owns, so without this the user sees "another app is using that"
 * about a clash with themselves. Disabled hotkeys (`""`) never collide with each other.
 */
export function findDuplicateAccelerators(hotkeys: Record<string, string>): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];

  for (const [name, accelerator] of Object.entries(hotkeys)) {
    if (accelerator === "") continue;
    const key = normalizeAccelerator(accelerator);
    const owner = seen.get(key);
    if (owner === undefined) {
      seen.set(key, name);
      continue;
    }
    if (!duplicates.includes(owner)) duplicates.push(owner);
    duplicates.push(name);
  }

  return duplicates;
}
