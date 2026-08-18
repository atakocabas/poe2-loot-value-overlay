/**
 * A minimal PNG encoder for `icon-art.ts`'s output, and nothing more general than that.
 *
 * It exists because both consumers of the mark want PNG and neither can have a dependency that
 * produces one: `scripts/make-icons.js` builds the installer's .ico, whose entries are PNGs, and
 * `icon.ts` hands PNG bytes to `nativeImage.createFromBuffer` — unambiguous, unlike raw pixels,
 * which that call would read in Skia's native BGRA-premultiplied order.
 *
 * Scope is deliberately one image kind: 8-bit RGBA, one IDAT, filter type 0 on every scanline. No
 * filtering because these are a few hundred KB of flat gradient at worst and the encoder staying
 * this short is worth more than the bytes. **Nothing here may import electron** — same rule as
 * `icon-art.ts`, and for the same reason.
 */

import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Length, type, data, CRC — where the CRC covers the type as well as the data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * Encodes `size * size * 4` straight-alpha RGBA bytes as a PNG.
 *
 * Deterministic for a given zlib build, which matters: the .ico is regenerated on every `npm run
 * build`, and an encoder that varied would show every build as a modified binary.
 */
export function encodePng(size: number, rgba: Buffer): Buffer {
  const stride = size * 4;
  // One extra byte per row for the filter type — that byte is the entire "filtering" this does.
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6: truecolour with alpha
  // Bytes 10-12 are compression, filter and interlace methods — 0 is the only defined value for each.

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
