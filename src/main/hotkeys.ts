import { globalShortcut } from "electron";
import type { Settings } from "../shared/settings";

export interface HotkeyHandlers {
  onToggleList: () => void;
  onForceCapture: () => void;
}

/** What became of one binding. `registered` is true for a disabled (empty) hotkey — nothing failed. */
export interface HotkeyResult {
  /** The `hotkeys.*` key, so a caller can name the field the user needs to change. */
  name: string;
  accelerator: string;
  registered: boolean;
}

/**
 * `globalShortcut.register()` **returns false** when another running app already owns the combo —
 * it doesn't throw — so the return value has to be checked or a hotkey that never registered is
 * indistinguishable from one whose handler does nothing. Both failure modes name the setting, since
 * the settings window and settings.json are both routes to a different accelerator.
 */
function registerOne(name: string, accelerator: string, callback: () => void): boolean {
  // An empty accelerator is how the settings window's Clear button says "disabled". Passing it to
  // register() throws, which the catch below would then report as another app holding the combo.
  if (accelerator === "") {
    console.log(`[hotkeys] ${name} is not bound`);
    return true;
  }

  try {
    if (globalShortcut.register(accelerator, callback)) return true;
    console.warn(
      `[hotkeys] ${name} (${accelerator}) was refused — another app likely holds it. ` +
        `Pick a different combo from the tray's Settings…`
    );
  } catch (error) {
    console.warn(`[hotkeys] failed to register ${name} (${accelerator})`, (error as Error).message);
  }
  return false;
}

export function registerHotkeys(settings: Settings, handlers: HotkeyHandlers): HotkeyResult[] {
  const bindings: Array<[string, string, () => void]> = [
    ["toggleList", settings.hotkeys.toggleList, handlers.onToggleList],
    ["forceCapture", settings.hotkeys.forceCapture, handlers.onForceCapture]
  ];

  return bindings.map(([name, accelerator, callback]) => ({
    name,
    accelerator,
    registered: registerOne(name, accelerator, callback)
  }));
}

/**
 * Whether the OS will hand us this combo, learned by taking it for an instant and giving it back.
 * There is no other signal: Electron exposes no "is this available" call, and `register` reports
 * refusal only through its return value.
 *
 * **Only accurate while our own hotkeys are unregistered.** Probing an accelerator this app has
 * already bound reports it as taken — by itself. `SAVE_SETTINGS_CONFIG` therefore calls
 * `unregisterAllHotkeys()` itself immediately before its probe loop rather than assuming they are
 * already down; the same suspension is what lets the settings window's key recorder see a bound
 * combo at all, but that one lasts only as long as a recorder is armed.
 */
export function probeAccelerator(accelerator: string): boolean {
  if (accelerator === "") return true;

  try {
    if (!globalShortcut.register(accelerator, () => {})) return false;
    globalShortcut.unregister(accelerator);
    return true;
  } catch {
    return false;
  }
}

export function unregisterAllHotkeys(): void {
  globalShortcut.unregisterAll();
}
