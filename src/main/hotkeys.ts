import { globalShortcut } from "electron";
import type { Settings } from "../shared/settings";

export interface HotkeyHandlers {
  onToggleOverlay: () => void;
  onToggleSession: () => void;
  onForceCapture: () => void;
}

/**
 * `globalShortcut.register()` **returns false** when another running app already owns the combo —
 * it doesn't throw — so the return value has to be checked or a hotkey that never registered is
 * indistinguishable from one whose handler does nothing. Both failure modes name the setting, since
 * the fix is to pick a different accelerator in settings.json.
 */
function registerOne(name: string, accelerator: string, callback: () => void): void {
  try {
    if (globalShortcut.register(accelerator, callback)) return;
    console.warn(
      `[hotkeys] ${name} (${accelerator}) was refused — another app likely holds it. ` +
        `Change hotkeys.${name} in settings.json.`
    );
  } catch (error) {
    console.warn(`[hotkeys] failed to register ${name} (${accelerator})`, (error as Error).message);
  }
}

export function registerHotkeys(settings: Settings, handlers: HotkeyHandlers): void {
  registerOne("toggleOverlay", settings.hotkeys.toggleOverlay, handlers.onToggleOverlay);
  registerOne("toggleSession", settings.hotkeys.toggleSession, handlers.onToggleSession);
  registerOne("forceCapture", settings.hotkeys.forceCapture, handlers.onForceCapture);
}

export function unregisterAllHotkeys(): void {
  globalShortcut.unregisterAll();
}
