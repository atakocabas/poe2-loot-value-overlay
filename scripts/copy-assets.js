const fs = require("node:fs");
const path = require("node:path");

const copies = [
  ["src/renderer/index.html", "dist/renderer/index.html"],
  ["src/renderer/style.css", "dist/renderer/style.css"],
  // The two ordinary framed windows, and the sheet they share. style.css above is the overlay's
  // alone — it describes a transparent click-through panel and neither form uses it.
  ["src/renderer/setup.html", "dist/renderer/setup.html"],
  ["src/renderer/settings.html", "dist/renderer/settings.html"],
  ["src/renderer/form.css", "dist/renderer/form.css"]
];

for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
