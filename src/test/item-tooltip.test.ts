import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, test } from "node:test";

/**
 * `renderItemText` lives in `src/renderer/common.ts`, which the renderer loads as a plain `<script>`
 * and which therefore exports nothing. Same approach as `item-groups.test.ts`: run the compiled file
 * in a `vm` context and read the function off that context's global, which is how the page gets it.
 *
 * The stubs are the three DOM calls it makes. `getElementById` because common.js resolves
 * `#item-tooltip` at top level, plus `createElement`/`createDocumentFragment` for the lines
 * themselves — the fragment keeps its children in an array so the test can read back what was built.
 */
interface StubLine {
  className: string;
  textContent: string;
}

function loadRenderItemText(): (text: string) => { children: StubLine[] } {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "common.js"), "utf-8");
  const context = vm.createContext({
    document: {
      getElementById: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      createElement: (): StubLine => ({ className: "", textContent: "" }),
      createDocumentFragment: () => {
        const children: StubLine[] = [];
        return { children, append: (child: StubLine) => children.push(child) };
      }
    }
  });
  vm.runInContext(source, context);

  const render = (context as { renderItemText?: (text: string) => { children: StubLine[] } })
    .renderItemText;
  assert.ok(render, "common.js no longer exposes renderItemText on the script global");
  return render;
}

const ADVANCED_RARE = [
  "Item Class: Body Armours",
  "Rarity: Rare",
  "Ghoul Hide",
  "Runeforged Falconer's Jacket",
  "--------",
  "Quality: +20% (augmented)",
  "Evasion Rating: 1301 (augmented)",
  "--------",
  "Item Level: 81",
  "--------",
  '{ Prefix Modifier "Banshee\'s" (Tier: 1) — Evasion, Energy Shield }',
  "+144(142-161) to Evasion Rating",
  "5% increased Movement Speed"
].join("\n");

/** `[class, text]` for each line built, which is all these assertions care about. */
function linesOf(text: string): Array<[string, string]> {
  return loadRenderItemText()(text).children.map((line) => [line.className, line.textContent]);
}

describe("the hover tooltip's item text", () => {
  test("each part of an item gets its own class, in the order the game printed it", () => {
    assert.deepEqual(linesOf(ADVANCED_RARE), [
      ["tip-meta", "Item Class: Body Armours"],
      ["tip-meta", "Rarity: Rare"],
      ["tip-name", "Ghoul Hide"],
      ["tip-base", "Runeforged Falconer's Jacket"],
      ["tip-sep", ""],
      ["tip-prop", "Quality: +20% (augmented)"],
      ["tip-prop", "Evasion Rating: 1301 (augmented)"],
      ["tip-sep", ""],
      ["tip-prop", "Item Level: 81"],
      ["tip-sep", ""],
      // The affix header is metadata about the roll below it, and the longest line on the item —
      // left at full brightness it shouts over the roll it describes.
      ["tip-affix", '{ Prefix Modifier "Banshee\'s" (Tier: 1) — Evasion, Energy Shield }'],
      ["tip-mod", "+144(142-161) to Evasion Rating"],
      ["tip-mod", "5% increased Movement Speed"]
    ]);
  });

  test("it classifies and never rewrites", () => {
    // The tooltip is the only place the raw capture can be read. A line quietly reworded here would
    // be a lie about what the parser was handed, so every non-separator line must survive verbatim.
    const source = ADVANCED_RARE.split("\n");
    const rendered = linesOf(ADVANCED_RARE);

    assert.equal(rendered.length, source.length, "no line may be dropped or invented");
    source.forEach((line, index) => {
      const [className, text] = rendered[index]!;
      if (className === "tip-sep") {
        assert.equal(line, "--------", "only a separator may lose its text");
      } else {
        assert.equal(text, line);
      }
    });
  });

  test("a separator carries no text of its own", () => {
    // It is drawn as a rule in CSS. Left as eight dashes it reads as another line of content.
    const [line] = linesOf("--------");
    assert.deepEqual(line, ["tip-sep", ""]);
  });

  test("without the header gate, line three is not treated as a name", () => {
    // `hasHeader` mirrors the parser's own gate. Text that doesn't open with Item Class then Rarity
    // isn't an item this app captured, and guessing at a name would colour an arbitrary line gold.
    assert.deepEqual(linesOf("some text\nmore text\nthird line"), [
      ["tip-mod", "some text"],
      ["tip-mod", "more text"],
      ["tip-mod", "third line"]
    ]);
  });

  test("a currency item has no base-type line to mistake for one", () => {
    // Three header lines then a separator, not four: the name *is* the base type. The separator
    // check runs first, so index 3 never picks up the `tip-base` colour here.
    assert.deepEqual(linesOf("Item Class: Stackable Currency\nRarity: Currency\nDivine Orb\n--------\nStack Size: 3/10"), [
      ["tip-meta", "Item Class: Stackable Currency"],
      ["tip-meta", "Rarity: Currency"],
      ["tip-name", "Divine Orb"],
      ["tip-sep", ""],
      ["tip-prop", "Stack Size: 3/10"]
    ]);
  });

  test("a mod written as \"Label: value\" takes the property shade, and that is accepted", () => {
    // A known and deliberate limitation. `Grants Skill: Level 1 Fireball` is a real mod, but it is
    // shaped exactly like a property line and lands on the property colour. The alternative is a
    // hardcoded list of PoE2's property labels, which would drift every league and fail silently
    // when it did. The cost here is one mod rendered a shade cooler than its neighbours; the text
    // is untouched either way, which is the guarantee that actually matters. Pinned so that if the
    // heuristic is ever tightened, this is the case to check.
    assert.deepEqual(linesOf("Item Class: Rings\nRarity: Rare\nR\nB\n--------\nGrants Skill: Level 1 Fireball"), [
      ["tip-meta", "Item Class: Rings"],
      ["tip-meta", "Rarity: Rare"],
      ["tip-name", "R"],
      ["tip-base", "B"],
      ["tip-sep", ""],
      ["tip-prop", "Grants Skill: Level 1 Fireball"]
    ]);
  });
});
