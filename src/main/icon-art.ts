/**
 * The app's mark, as geometry — a gold hexagonal gem cut by a V-shaped facet band, so the lit stone
 * above the cut reads as an upward chevron. Loot and a rising price in one silhouette.
 *
 * It is drawn rather than loaded because the alternatives are both worse here. Rasterising an
 * authored SVG needs `sharp`/`resvg`, which are native modules — ruled out for the same reason
 * `better-sqlite3` and `active-win` were. Committing hand-drawn PNGs instead means seven binaries
 * (16 through 256, plus the installer's) kept in sync by hand, and the first edit desynchronises
 * them silently. One geometry, two forms, every size derived.
 *
 * **Nothing here may import electron.** `scripts/make-icons.js` requires this module out of `dist/`
 * to build the installer's .ico at build time, long before there is an app to have a `nativeImage`.
 * The electron side is `icon.ts`.
 *
 * Everything below is in a unit square with y pointing down, so a size is only ever applied at the
 * very end — that is what makes 16px and 256px the same picture rather than two drawings.
 */

/** Transparent for the tray (the taskbar shows through); on a dark plate for the exe and windows. */
export type IconForm = "tray" | "plate";

/** r, g, b in 0-255; a in 0-1. Straight (un-premultiplied) alpha. */
type Rgba = readonly [number, number, number, number];
type Rgb = readonly [number, number, number];
type Point = readonly [number, number];

const TRANSPARENT: Rgba = [0, 0, 0, 0];

// The stone. Lit from the upper left, which is also where the specular sits.
const GEM_LIT: Rgb = [246, 220, 138];
const GEM_DEEP: Rgb = [169, 124, 34];
const GEM_RIM: Rgb = [109, 74, 18];

// The plate, matching the two framed windows' background (#14161c in form.css) so the icon and the
// window it opens are visibly the same app.
const PLATE_TOP: Rgb = [35, 39, 51];
const PLATE_BOTTOM: Rgb = [20, 22, 28];

/**
 * What the chevron is cut in for the tray form. Not fully opaque black: at 16px the cut is under two
 * pixels wide, and a hard black notch reads as a defect rather than a facet.
 */
const TRAY_CUT: Rgba = [20, 22, 28, 0.9];

/** Pointy-top hexagon: vertical girdle, points at 12 and 6 o'clock. Wound clockwise. */
const GEM_OUTLINE: readonly Point[] = [
  [0.5, 0.05],
  [0.86, 0.3],
  [0.86, 0.7],
  [0.5, 0.95],
  [0.14, 0.7],
  [0.14, 0.3]
];

/**
 * The cut. Its arms deliberately end *outside* the hexagon — the silhouette clips them, so the band
 * runs off both girdles like a real facet instead of floating with two visible stubs.
 */
const CHEVRON: readonly Point[] = [
  [0.1, 0.84],
  [0.5, 0.4],
  [0.9, 0.84]
];

/** Crown facet: the top point down to the chevron's apex. */
const FACET: readonly Point[] = [
  [0.5, 0.05],
  [0.5, 0.4]
];
const FACET_HALF_WIDTH = 0.0075;

/** The girdle. It is what keeps the silhouette a hexagon against a light Windows 11 taskbar. */
const RIM_WIDTH = 0.022;

// Where the gem sits on the plate. Raised a little above the geometric centre because the plate's
// own rounded corners pull the eye down otherwise.
const GEM_SCALE = 0.72;
const GEM_CENTRE_Y = 0.48;

const PLATE_INSET = 0.03;
const PLATE_RADIUS = 0.2;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * 0 at `from`, 1 at `to`, smoothly in between and clamped outside. `from` may be the larger of the
 * two, which is how the highlights here are written: they fade *out* with distance.
 */
function smoothstep(from: number, to: number, n: number): number {
  const t = clamp01((n - from) / (to - from));
  return t * t * (3 - 2 * t);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Straight-alpha source-over. */
function over(dst: Rgba, src: Rgba): Rgba {
  if (src[3] <= 0) return dst;
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a <= 0) return TRANSPARENT;
  const blend = (i: number) => (src[i] * src[3] + dst[i] * dst[3] * (1 - src[3])) / a;
  return [blend(0), blend(1), blend(2), a];
}

/**
 * Half-plane test, valid because the hexagon is convex and consistently wound: a point is inside
 * when it is on the same side of every edge.
 */
function insideConvexPolygon(polygon: readonly Point[], x: number, y: number): boolean {
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
  }
  return true;
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp01(((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared);
  return Math.hypot(x - (a[0] + dx * t), y - (a[1] + dy * t));
}

function distanceToPolyline(points: readonly Point[], x: number, y: number, closed = false): number {
  let best = Infinity;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) {
    const d = distanceToSegment(x, y, points[i], points[(i + 1) % points.length]);
    if (d < best) best = d;
  }
  return best;
}

function insideRoundedRect(x: number, y: number, inset: number, radius: number): boolean {
  const min = inset + radius;
  const max = 1 - inset - radius;
  const cx = x < min ? min : x > max ? max : x;
  const cy = y < min ? min : y > max ? max : y;
  // Inside the straight middle either way, this reduces to the plain rectangle test.
  if (cx === x && cy === y) return true;
  return Math.hypot(x - cx, y - cy) <= radius;
}

/**
 * The stone, in its own unit square. `cut` is what the chevron is drawn in — near-black for the
 * tray, the plate's own colour for the plate form, so it reads as cut *through* the stone rather
 * than painted onto it.
 *
 * `detail` is the only thing in this file that knows how big the icon is, and it is a design
 * decision rather than an optimisation: the specular and the crown facet are under a pixel wide at
 * 16px, where they land as haze over the one thing that has to survive. Below the threshold they
 * come off, the cut widens to hold its shape, and the rim goes to full strength so the silhouette
 * stays a hexagon instead of blurring into a blob.
 */
function gemColour(x: number, y: number, cut: Rgba, detail: Detail): Rgba {
  if (!insideConvexPolygon(GEM_OUTLINE, x, y)) return TRANSPARENT;

  // Lit from the upper left: the ramp runs along the leading diagonal, not down the page.
  const lightT = clamp01(((x + y) / 2 - 0.18) / 0.5);
  let colour: Rgba = [...mix(GEM_LIT, GEM_DEEP, lightT), 1] as Rgba;

  if (detail === "fine") {
    const specular = Math.hypot((x - 0.36) / 0.13, (y - 0.24) / 0.09);
    colour = over(colour, [255, 255, 255, 0.22 * smoothstep(1, 0.2, specular)]);

    if (distanceToPolyline(FACET, x, y) < FACET_HALF_WIDTH) {
      colour = over(colour, [255, 255, 255, 0.25]);
    }
  }

  // The rim goes down *before* the cut, so the cut runs through the girdle rather than stopping at
  // it. Drawn the other way round the arms end in two stubs, and at 16px the rim welds them into
  // the outline and the whole mark collapses into a dark smudge across a gold blob.
  if (distanceToPolyline(GEM_OUTLINE, x, y, true) < RIM_WIDTH) {
    colour = over(colour, [...GEM_RIM, detail === "fine" ? 0.6 : 0.9] as Rgba);
  }
  if (distanceToPolyline(CHEVRON, x, y) < (detail === "fine" ? 0.058 : 0.07)) {
    colour = over(colour, cut);
  }
  return colour;
}

function plateColour(x: number, y: number): Rgba {
  if (!insideRoundedRect(x, y, PLATE_INSET, PLATE_RADIUS)) return TRANSPARENT;
  return [...mix(PLATE_TOP, PLATE_BOTTOM, clamp01((y - PLATE_INSET) / (1 - 2 * PLATE_INSET))), 1] as Rgba;
}

function sampleColour(x: number, y: number, form: IconForm, detail: Detail): Rgba {
  if (form === "tray") return gemColour(x, y, TRAY_CUT, detail);

  const plate = plateColour(x, y);
  if (plate[3] === 0) return TRANSPARENT;

  const glow = Math.hypot(x - 0.5, y - GEM_CENTRE_Y) / 0.42;
  const lit = over(plate, [212, 175, 55, 0.18 * smoothstep(1, 0, glow)]);

  const gemX = (x - 0.5) / GEM_SCALE + 0.5;
  const gemY = (y - GEM_CENTRE_Y) / GEM_SCALE + 0.5;
  return over(lit, gemColour(gemX, gemY, plate, detail));
}

/** Samples per pixel per axis, so 16 evaluations of the finished composite for each pixel. */
const SUPERSAMPLE = 4;

type Detail = "fine" | "coarse";

/**
 * Below this the fine facets are drawn away — see `gemColour`. The plate form crosses it earlier
 * because its gem is only `GEM_SCALE` of the canvas, so its details reach a pixel wide later.
 */
function detailFor(size: number, form: IconForm): Detail {
  return size >= (form === "plate" ? 48 : 32) ? "fine" : "coarse";
}

/**
 * Renders the mark at `size`, as `size * size * 4` bytes of straight-alpha **RGBA** — the order PNG
 * wants, which is what both consumers ultimately encode to. (Feeding raw pixels to
 * `nativeImage.createFromBuffer` instead would mean matching Skia's native BGRA-premultiplied order,
 * an easy thing to get silently backwards; `icon.ts` goes through PNG rather than risk it.)
 *
 * Antialiasing is done by supersampling the *composite* rather than per shape: every edge, gradient,
 * highlight and clipped facet end gets the same treatment, and no shape has to know it is being
 * drawn small.
 */
export function renderIcon(size: number, form: IconForm): Buffer {
  const buffer = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const detail = detailFor(size, form);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const colour = sampleColour(
            (px + (sx + 0.5) / SUPERSAMPLE) / size,
            (py + (sy + 0.5) / SUPERSAMPLE) / size,
            form,
            detail
          );
          // Weighted by alpha, so a pixel half-covered by the gem averages the gem's colour and not
          // the gem blended halfway to black.
          r += colour[0] * colour[3];
          g += colour[1] * colour[3];
          b += colour[2] * colour[3];
          a += colour[3];
        }
      }

      const offset = (py * size + px) * 4;
      if (a > 0) {
        buffer[offset] = Math.round(r / a);
        buffer[offset + 1] = Math.round(g / a);
        buffer[offset + 2] = Math.round(b / a);
        buffer[offset + 3] = Math.round((a / samples) * 255);
      }
    }
  }

  return buffer;
}
