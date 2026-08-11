const fs = require("node:fs");
const path = require("node:path");

const copies = [
  ["src/renderer/index.html", "dist/renderer/index.html"],
  ["src/renderer/style.css", "dist/renderer/style.css"],
  // The setup window's page. It carries its own styles inline, so there's no sheet to copy with it.
  ["src/renderer/setup.html", "dist/renderer/setup.html"]
];

for (const [from, to] of copies) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
