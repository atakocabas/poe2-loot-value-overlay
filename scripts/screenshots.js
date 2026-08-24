/**
 * Draws the screenshots the README embeds, straight out of the real renderer.
 *
 * Run with `npm run screenshots` (which builds first — this reads `dist/renderer/`, the same
 * arrangement as scripts/make-icons.js). It opens each page with scripts/screenshot-preload.js in
 * place of the app's own preload, so `window.poe2Overlay` answers from a fixed scene instead of the
 * main process: the panel that paints is the shipped one, with the shipped stylesheet, and no game,
 * network or clipboard is involved.
 *
 * **The PNGs are committed, unlike `build/`.** GitHub has to serve them at a URL for the README to
 * show anything, so `docs/images/` is source rather than generated output and must not be moved into
 * an ignored directory. Re-run this after any change to the panel's markup or styles.
 *
 * Not wired into `npm run build`: five PNGs rewritten on every compile would churn the diff for
 * changes that never touch the UI.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { STATUS } = require("./screenshot-data");

const ROOT = path.join(__dirname, "..");
const RENDERER = path.join(ROOT, "dist", "renderer");
const OUT_DIR = path.join(ROOT, "docs", "images");
const PRELOAD = path.join(__dirname, "screenshot-preload.js");

/**
 * Rendered at 2x and displayed at half that, so the text is sharp on a high-DPI screen. Every DIP
 * measurement below is a CSS pixel multiplied by the shot's zoom.
 */
const ZOOM = 2;

/**
 * The two framed windows are shot at their real content size, and Windows clamps a window to the
 * display — 560x680 at 2x asks for 1360 DIP of height, which no ordinary screen grants. 1.5 fits and
 * is still sharper than 1x.
 */
const FORM_ZOOM = 1.5;

/**
 * The panel is `background: transparent` on `body` — it's a sheet over the game — so on its own it
 * captures as a pale box with unreadable translucent fills. This stands in for the game behind it:
 * dark, neutral, and nothing anyone could mistake for GGG's art.
 */
const BACKDROP = `
  html, body {
    background: radial-gradient(1200px 800px at 70% 20%, #23262f 0%, #131519 55%, #0b0c0f 100%);
  }
`;

/** Padding kept around the panel in the crop, in CSS pixels, so the border isn't flush to the edge. */
const MARGIN = 18;

/**
 * How tall the window holding the panel is, in DIP. Deliberately larger than any display: the panel
 * is `max-height: 80vh`, so asking for more than the screen and letting Windows clamp it is what
 * makes the shot as tall as this machine allows. `TRIM_TO_WHOLE_ROWS` below is what keeps the bottom
 * edge clean however that lands.
 */
const PANEL_WINDOW_HEIGHT = 1700;

/**
 * Every window opened so far, torn down together once the last shot is taken.
 *
 * Not per shot, which is what this looked like first: the pages are all `file://`, so Chromium runs
 * them in one renderer process, and destroying a window while the next one is navigating aborts that
 * navigation with a bare `ERR_FAILED`. Keeping five hidden windows alive for the length of one
 * script is cheaper than sequencing around it.
 */
const windows = [];

async function shoot({ name, page, width, height, prepare, target = "#panel", zoom = ZOOM }) {
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    backgroundColor: "#0b0c0f",
    webPreferences: {
      preload: PRELOAD,
      // The whole point of the harness: the stub has to be able to assign `window.poe2Overlay` on
      // the page's own window. The app's preload keeps `contextBridge` and is untouched.
      contextIsolation: false,
      // The preload requires a sibling file, which the default sandbox forbids.
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  windows.push(window);

  await window.loadFile(path.join(RENDERER, page));
  // Set here rather than as a `webPreferences.zoomFactor`, which is quietly overridden: Chromium
  // remembers a zoom level per origin, every page here is `file://`, and one shot's zoom therefore
  // leaks into the next window — and into a later run of this script, which is how the framed
  // windows first came out rendered at half their real width.
  window.webContents.setZoomFactor(zoom);
  // Only the panel needs a backdrop; the framed forms paint their own, and the gradient would only
  // show up as a band under a form shorter than its window.
  if (target) await window.webContents.insertCSS(BACKDROP);
  // `load()` in the renderer is async and paints from its answers, and a shot's `prepare` clicks
  // buttons whose handlers await another round trip. One frame is not enough for either.
  await settle(window, 3);
  if (prepare) {
    await window.webContents.executeJavaScript(prepare, true);
    await settle(window, 3);
  }

  if (!target) await fitToContent(window, zoom);

  const image = target
    ? await window.webContents.capturePage(
        cropOf(await rectOf(window, target), window.getContentSize(), zoom)
      )
    : // No crop: the whole window, exactly as the app opens it.
      await window.webContents.capturePage();
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());

  const { width: w, height: h } = image.getSize();
  console.log(`screenshots: ${path.relative(ROOT, file)} (${w}x${h})`);
}

/**
 * Shrinks an uncropped window to the height its page actually fills.
 *
 * Both framed windows open at a fixed size and are resizable, because the explanatory text reflows —
 * so a form shorter than its window is an ordinary sight, but in a screenshot the empty strip below
 * it reads as a rendering fault. Only ever shrinks: a form longer than its window (the settings one)
 * scrolls in the app and scrolls here.
 */
async function fitToContent(window, zoom) {
  // The last child's bottom plus the body's own padding, not `scrollHeight` — that never reports
  // less than the viewport, so it can't say a page is shorter than the window holding it.
  const height = await window.webContents.executeJavaScript(
    `(() => {
       const bottoms = [...document.body.children].map((el) => el.getBoundingClientRect().bottom);
       const padding = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
       return Math.max(...bottoms) + padding;
     })()`,
    true
  );
  const [width, current] = window.getContentSize();
  const fitted = Math.ceil(height * zoom);
  if (fitted < current) {
    window.setContentSize(width, fitted);
    await settle(window, 2);
  }
}

/** One element's CSS-pixel rect, as the page itself measures it. */
function rectOf(window, selector) {
  return window.webContents.executeJavaScript(
    `(() => {
       const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
       return { x: r.x, y: r.y, width: r.width, height: r.height };
     })()`,
    true
  );
}

/**
 * Turns the element's CSS-pixel rect into the DIP rect `capturePage` crops by, padded and clamped.
 * Asking for a rect that runs off the content area returns a black band rather than an error.
 */
function cropOf(rect, [contentWidth, contentHeight], zoom) {
  const x = Math.max(0, Math.floor((rect.x - MARGIN) * zoom));
  const y = Math.max(0, Math.floor((rect.y - MARGIN) * zoom));
  return {
    x,
    y,
    width: Math.min(Math.ceil((rect.width + MARGIN * 2) * zoom), contentWidth - x),
    height: Math.min(Math.ceil((rect.height + MARGIN * 2) * zoom), contentHeight - y)
  };
}

/** Waits out N painted frames, which is the only honest way to know the DOM work has landed. */
function settle(window, frames) {
  return window.webContents.executeJavaScript(
    `new Promise((resolve) => {
       let left = ${frames};
       const tick = () => (left-- > 0 ? requestAnimationFrame(tick) : resolve(true));
       tick();
     })`,
    true
  );
}

/**
 * The panel's two forms come from one status field, and `applyStatus` is a plain function in the
 * renderer's shared global scope (the pages are `<script>` tags, not modules), so the harness can
 * call it exactly as an OVERLAY_STATUS push would.
 */
function statusPush(overrides) {
  return `applyStatus(Object.assign({}, ${JSON.stringify(STATUS)}, ${JSON.stringify(overrides)}))`;
}

/**
 * Caps the list at the last row that fits whole.
 *
 * `max-height: 80vh` cuts wherever the viewport happens to end, which is usually through the middle
 * of a row — true to how the panel behaves in game, and it reads as a broken image in a README.
 * Purely cosmetic and applied to the shot alone; the scrollbar is left showing, so the list still
 * says it continues.
 */
const TRIM_TO_WHOLE_ROWS = `(() => {
  const list = document.getElementById("item-list");
  const top = list.getBoundingClientRect().top;
  let last = 0;
  for (const row of list.children) {
    const bottom = row.getBoundingClientRect().bottom - top;
    if (bottom > list.clientHeight) break;
    last = bottom;
  }
  if (last > 0) list.style.maxHeight = Math.ceil(last) + "px";
  return true;
})()`;

/** Presses the Edit button on one row, found by the item name that row shows. */
function openEditorFor(name) {
  return `(async () => {
     const rows = [...document.querySelectorAll("#item-list .item-row")];
     const row = rows.find((r) => r.textContent.includes(${JSON.stringify(name)}));
     [...row.querySelectorAll("button")].find((b) => b.textContent === "Edit").click();
     // The handler awaits getEditorRows before it builds anything, so the editor is not in the DOM
     // by the time click() returns.
     await new Promise((r) => setTimeout(r, 150));
     return true;
   })()`;
}

/** Runs several prepare snippets in order, awaiting each. */
function steps(...snippets) {
  return `(async () => {
     ${snippets.map((snippet) => `await (${snippet});`).join("\n     ")}
     return true;
   })()`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  await shoot({
    name: "panel-full",
    page: "index.html",
    width: 900,
    height: PANEL_WINDOW_HEIGHT,
    prepare: steps(statusPush({ expanded: true }), TRIM_TO_WHOLE_ROWS)
  });

  await shoot({
    name: "panel-minimal",
    page: "index.html",
    width: 900,
    height: 600,
    // Click-through as well as collapsed: the resting form passes every click to the game, and the
    // accent border is the panel's only cue that it is listening.
    prepare: statusPush({ expanded: false, interactive: false })
  });

  await shoot({
    name: "row-editor",
    page: "index.html",
    width: 900,
    height: PANEL_WINDOW_HEIGHT,
    prepare: steps(
      statusPush({ expanded: true }),
      openEditorFor("Damnation Shell"),
      TRIM_TO_WHOLE_ROWS
    )
  });

  // The two framed windows are shot whole and at the exact size main/ opens them at, scroll position
  // included — they are ordinary opaque forms, so there is no panel to crop to, no backdrop showing
  // through, and no reason to show them at a size nobody's install uses. The settings form is longer
  // than its window and scrolls in the app too.
  await shoot({
    name: "settings-window",
    page: "settings.html",
    width: 560 * FORM_ZOOM,
    height: 680 * FORM_ZOOM,
    target: null,
    zoom: FORM_ZOOM
  });

  await shoot({
    name: "setup-window",
    page: "setup.html",
    width: 600 * FORM_ZOOM,
    height: 700 * FORM_ZOOM,
    target: null,
    zoom: FORM_ZOOM
  });

  for (const window of windows) window.destroy();
}

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (error) {
    console.error("screenshots: failed —", error);
    app.exit(1);
  }
});
