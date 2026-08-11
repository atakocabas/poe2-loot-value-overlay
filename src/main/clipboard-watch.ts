import { clipboard } from "electron";

const POLL_INTERVAL_MS = 150;

// Some item clipboard text (e.g. Waystones) is prefixed with an "Item Class: X" line before
// "Rarity:", so the item text doesn't necessarily start at position 0 — match the line anywhere
// near the top rather than requiring it to be the first characters.
const ITEM_TEXT_PATTERN = /^Rarity:/m;

function looksLikeItemText(text: string): boolean {
  return ITEM_TEXT_PATTERN.test(text);
}

/**
 * Watches the OS clipboard for PoE2 item text. PoE2's native Ctrl+C ("copy item as text") is
 * what actually populates the clipboard — this class never registers Ctrl+C as a hotkey itself,
 * because Electron's globalShortcut intercepts the key combination system-wide and would
 * prevent PoE2 (the focused window) from ever receiving the keystroke, so the game would never
 * write the item text in the first place. Polling and comparing against the last-seen value is
 * the standard approach (e.g. Awakened PoE Trade works the same way).
 */
export class ClipboardWatcher {
  private lastSeenText = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onItemCopied: (text: string) => void) {}

  start(): void {
    this.lastSeenText = clipboard.readText();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    console.log("[clipboard] watching for item copies (Ctrl+C)");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Manual fallback trigger (bound to a hotkey): re-reads the clipboard right now and queues it
   * if it's an item, even if it's identical to the last-seen value — unlike the automatic poll,
   * which only reacts to changes, this always fires so the user can explicitly re-capture.
   */
  forceCapture(): void {
    const text = clipboard.readText();
    this.lastSeenText = text;
    console.log("[clipboard] force-capture hotkey pressed");
    if (looksLikeItemText(text)) {
      this.onItemCopied(text);
    } else {
      console.log("[clipboard] clipboard doesn't look like item text");
    }
  }

  private poll(): void {
    const text = clipboard.readText();
    if (text === this.lastSeenText) return;

    this.lastSeenText = text;
    if (looksLikeItemText(text)) {
      console.log("[clipboard] Ctrl+C item text detected");
      this.onItemCopied(text);
    } else {
      console.log("[clipboard] clipboard changed but doesn't look like item text");
    }
  }
}
