import assert from "node:assert/strict";
import { test } from "node:test";
import { renderIcon, type IconForm } from "../main/icon-art";

/**
 * What a test can check about a picture is that the picture is *there* — the silhouette is the shape
 * it claims to be, the cut is present, and the whole thing is reproducible. Whether it looks good is
 * checked by rendering it and looking; see the note on `renderIcon`.
 */
function pixel(rgba: Buffer, size: number, u: number, v: number): [number, number, number, number] {
  const x = Math.min(size - 1, Math.floor(u * size));
  const y = Math.min(size - 1, Math.floor(v * size));
  const o = (y * size + x) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
}

/** Perceptually rough, but enough to say "this pixel is the dark cut, that one is lit stone". */
function brightness([r, g, b]: [number, number, number, number]): number {
  return (r + g + b) / 3;
}

test("renders exactly size * size RGBA pixels, at every size the .ico holds", () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    for (const form of ["tray", "plate"] as IconForm[]) {
      assert.equal(renderIcon(size, form).length, size * size * 4);
    }
  }
});

test("the tray form is a hexagon on transparency, not a filled square", () => {
  const size = 64;
  const icon = renderIcon(size, "tray");

  // The corners fall outside the hexagon's slanted shoulders, which is the whole point of the
  // silhouette: a tray icon that filled its box would read as a blank tile at 16px.
  for (const [u, v] of [
    [0.02, 0.02],
    [0.98, 0.02],
    [0.02, 0.98],
    [0.98, 0.98]
  ]) {
    assert.equal(pixel(icon, size, u, v)[3], 0, `corner ${u},${v} should be transparent`);
  }
  assert.equal(pixel(icon, size, 0.5, 0.5)[3], 255, "the middle of the stone should be opaque");
});

test("the stone is gold, and the chevron is cut through it", () => {
  const size = 128;
  const icon = renderIcon(size, "tray");

  const stone = pixel(icon, size, 0.5, 0.2);
  assert.ok(stone[0] > stone[1] && stone[1] > stone[2], `gold runs r > g > b, got ${stone}`);

  // Just under the cut's apex versus the lit stone directly above it. If the chevron ever stopped
  // being drawn, this is the assertion that would notice.
  const cut = pixel(icon, size, 0.5, 0.45);
  assert.ok(
    brightness(cut) < brightness(stone) / 2,
    `the cut should be markedly darker than the stone: ${brightness(cut)} vs ${brightness(stone)}`
  );
});

test("the plate form is a rounded tile — cut corners, solid edges", () => {
  const size = 128;
  const icon = renderIcon(size, "plate");

  assert.equal(pixel(icon, size, 0.02, 0.02)[3], 0, "the rounded corner should be cut away");
  assert.equal(pixel(icon, size, 0.5, 0.06)[3], 255, "the top edge should be solid");
  assert.equal(pixel(icon, size, 0.06, 0.5)[3], 255, "the left edge should be solid");
});

test("rendering twice is byte-identical", () => {
  // The .ico is rebuilt by every `npm run build`. A renderer that varied would show up as a
  // modified binary on every build, and there would be no way to tell a real change from noise.
  assert.deepEqual(renderIcon(32, "tray"), renderIcon(32, "tray"));
  assert.deepEqual(renderIcon(256, "plate"), renderIcon(256, "plate"));
});
