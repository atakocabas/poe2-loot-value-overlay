import { Tray, Menu, nativeImage, type NativeImage } from "electron";

const ICON_SIZE = 32;
// Goldenrod, matching a currency-orb theme.
const ICON_COLOR: [number, number, number] = [212, 175, 55];

/** Draws a filled circle procedurally so the tray icon needs no external asset file. */
function createTrayIcon(): NativeImage {
  const buffer = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  const center = ICON_SIZE / 2;
  const radius = ICON_SIZE / 2 - 2;

  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const inside = dx * dx + dy * dy <= radius * radius;
      const offset = (y * ICON_SIZE + x) * 4;

      if (inside) {
        const [r, g, b] = ICON_COLOR;
        buffer[offset] = r;
        buffer[offset + 1] = g;
        buffer[offset + 2] = b;
        buffer[offset + 3] = 255;
      }
    }
  }

  return nativeImage.createFromBuffer(buffer, { width: ICON_SIZE, height: ICON_SIZE });
}

export interface TrayActions {
  onShowOverlay: () => void;
  onHideOverlay: () => void;
  /** Reopens the first-run setup window — the only route to the league, log path and contact email. */
  onOpenSetup: () => void;
  onQuit: () => void;
}

/**
 * Named actions rather than positional callbacks: three bare `() => void` parameters in a row are
 * easy to pass in the wrong order, and getting Quit where Hide was meant is not a recoverable
 * mistake.
 *
 * "Hide Overlay" exists because the window is frameless and `skipTaskbar`, so without it the only
 * way to get the panel off the screen is Quit — which ends the session too.
 */
export function createTray({ onShowOverlay, onHideOverlay, onOpenSetup, onQuit }: TrayActions): Tray {
  const tray = new Tray(createTrayIcon());
  tray.setToolTip("PoE2 Loot Value Overlay");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Overlay", click: onShowOverlay },
      { label: "Hide Overlay", click: onHideOverlay },
      { type: "separator" },
      { label: "Settings…", click: onOpenSetup },
      { type: "separator" },
      { label: "Quit", click: onQuit }
    ])
  );
  return tray;
}
