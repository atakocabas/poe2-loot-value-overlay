/**
 * Builds the icons electron-builder stamps into the exe, the NSIS installer and the uninstaller.
 *
 * Run from `npm run build`, after `tsc`, because it requires the mark's geometry out of `dist/` —
 * the same arrangement as scripts/verify-exchange-ids.js. Nothing here is committed: `build/` is
 * generated output like `dist/` and `release/`, and regenerating it on every build is what keeps it
 * from drifting from the source it was drawn from.
 *
 * **The small entries are the bare mark and the large ones are on a plate**, which is not an
 * inconsistency. Windows takes 16px from this file for title bars and Alt-Tab, and at 16px a rounded
 * plate spends most of its pixels on the plate and leaves the mark a smudge; the sizes that get used
 * large — the desktop, the installer header — want the plate so the icon reads as a tile rather than
 * a sticker.
 */
const fs = require("node:fs");
const path = require("node:path");
const { renderIcon } = require("../dist/main/icon-art");
const { encodePng } = require("../dist/main/icon-png");

/** Every size Windows picks from, and the form each one is drawn in. */
const SIZES = [
  [16, "tray"],
  [24, "tray"],
  [32, "tray"],
  [48, "plate"],
  [64, "plate"],
  [128, "plate"],
  [256, "plate"]
];

const ICONDIR_SIZE = 6;
const ICONDIRENTRY_SIZE = 16;

/**
 * Packs PNGs into an .ico. Entries have been allowed to be PNG rather than a DIB since Vista, which
 * is why there is no bitmap encoder here.
 */
function encodeIco(entries) {
  const header = Buffer.alloc(ICONDIR_SIZE);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(ICONDIRENTRY_SIZE * entries.length);
  let offset = ICONDIR_SIZE + directory.length;

  entries.forEach(({ size, png }, i) => {
    const at = i * ICONDIRENTRY_SIZE;
    // 256 is written as 0: the field is one byte, and 256 is the largest size an .ico can hold.
    directory[at] = size === 256 ? 0 : size;
    directory[at + 1] = size === 256 ? 0 : size;
    directory[at + 2] = 0; // palette size, 0 for truecolour
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

const out = path.join(__dirname, "..", "build");
fs.mkdirSync(out, { recursive: true });

const entries = SIZES.map(([size, form]) => ({ size, png: encodePng(size, renderIcon(size, form)) }));
fs.writeFileSync(path.join(out, "icon.ico"), encodeIco(entries));

// electron-builder wants a 256px .ico at minimum for Windows; the 512 PNG is what a future macOS or
// Linux target — and the README — would take, and costs one more render.
fs.writeFileSync(path.join(out, "icon.png"), encodePng(512, renderIcon(512, "plate")));

console.log(`icons: build/icon.ico (${SIZES.map(([s]) => s).join(", ")}) and build/icon.png (512)`);
