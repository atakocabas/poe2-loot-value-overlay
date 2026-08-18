import { nativeImage, type NativeImage } from "electron";
import { renderIcon } from "./icon-art";
import { encodePng } from "./icon-png";

/**
 * The runtime half of the app's mark — the tray, and the two framed windows' title bars. The
 * installer's .ico is the other half and is built by `scripts/make-icons.js` from the same geometry.
 *
 * Both go through PNG rather than handing raw pixels to `nativeImage.createFromBuffer`: that call
 * reads a raw buffer in Skia's native order, which is BGRA *premultiplied* on Windows, and getting
 * that backwards produces a plausible-looking icon in the wrong hue rather than an error.
 *
 * Memoised because both are asked for repeatedly — the settings window is opened and closed as often
 * as the user likes — and the rasteriser is 16 samples a pixel.
 */
function fromArt(size: number, form: "tray" | "plate"): NativeImage {
  return nativeImage.createFromBuffer(encodePng(size, renderIcon(size, form)));
}

let tray: NativeImage | null = null;
let app: NativeImage | null = null;

/**
 * The bare mark on transparency, so the taskbar's own colour shows through.
 *
 * Two representations rather than one: Windows asks for 16px at 100% scaling and 32px at 200%, and
 * a lone 16px image gets upscaled into mush on the second. Each is rendered at its own size, which
 * is the point of drawing the icon rather than shipping one bitmap — `renderIcon` simplifies the
 * facets below 32px instead of shrinking them into haze.
 */
export function trayIcon(): NativeImage {
  if (tray) return tray;
  tray = fromArt(16, "tray");
  tray.addRepresentation({ scaleFactor: 2, buffer: encodePng(32, renderIcon(32, "tray")) });
  return tray;
}

/** The plate form, for window title bars and their taskbar buttons. */
export function appIcon(): NativeImage {
  if (!app) app = fromArt(256, "plate");
  return app;
}
