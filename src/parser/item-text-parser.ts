// The clipboard item parser. **Read docs/parser.md before changing mod parsing.** PoE2's "Advanced
// Item Descriptions" option changes the mod format substantially, and this handles both halves of
// the player base: the header gate is authoritative when headers are present, and `isKnownNonModLine`
// is the whole guard when they aren't. Neither is optional.
import type {
  ItemDefences,
  ItemMapStats,
  ItemRarity,
  ItemWeaponStats,
  ModKind,
  ParsedItem,
  ParsedMod
} from "../shared/types";

const SECTION_SEPARATOR = /\r?\n-{5,}\r?\n/;
const PROPERTY_LINE = /^[A-Za-z][A-Za-z .]*:\s*.+$/;

/**
 * The "{ Prefix Modifier "Polar" (Tier: 1) — Elemental, Cold, Attack }" grouping headers PoE2 emits
 * when the player has **Advanced Item Descriptions** switched on. Two things are read out of it: the
 * leading word, which gives the `ModKind`, and the rest of the line, which is where the tier is. The
 * affix name and the tag list after the em dash are still ignored.
 */
const ADVANCED_MOD_HEADER = /^\{\s*(\w+)(.*)$/;

/**
 * The affix tier inside such a header. Read separately from `ADVANCED_MOD_HEADER` rather than as one
 * more optional group on it: the tier sits between the affix name and the tags, both of which are
 * free text, and a single pattern spanning all three would have to guess at their shape to stay
 * anchored. Absent on headers that carry no tier, which is why `ParsedMod.tier` is nullable.
 */
const MOD_TIER = /\(Tier:\s*(\d+)\)/;

/** The trailing marker on a mod line outside advanced mode, e.g. "... Energy Shield (rune)". */
const MOD_KIND_SUFFIX = /\s*\((implicit|rune|enchant|crafted|fractured|desecrated)\)\s*$/i;

/**
 * The inline roll range advanced descriptions splice into the number itself:
 * "Attacks Gain 20(19-20)% of Damage" and "34.9(33.1-36) Life Regeneration per second".
 *
 * It has to go before any stat matching. GGG's own stat templates carry a bare "#" placeholder, and
 * `TradeStatsMatcher` anchors its patterns end to end, so a range left in place matches nothing —
 * which silently reduced a six-mod rare to a base-type-only trade search.
 */
const ROLL_RANGE = /(\d)\((\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?\)/g;

function stripRollRanges(line: string): string {
  return line.replace(ROLL_RANGE, "$1");
}

/**
 * The bracket behind the **first** number on the line — `16(6-16)%` gives `{ min: 6, max: 16 }`.
 *
 * The first one specifically, because that is the number the search uses: GGG's templates carry a
 * bare `#` and `TradeStatsMatcher` reads its first capture group, so a line like `Adds 12(10-14) to
 * 25(20-30) Fire Damage` is filtered on the 12 and it is the 12's bracket that says how good a roll
 * that is.
 *
 * Null when the game printed no range, which is every capture made without **Advanced Item
 * Descriptions** — the same degraded-not-disabled case as `tier`. A single-value bracket (no dash)
 * yields an equal min and max, which reads correctly as "this affix has one possible roll".
 */
function parseRollRange(line: string): { min: number; max: number } | null {
  ROLL_RANGE.lastIndex = 0;
  const match = ROLL_RANGE.exec(line);
  if (!match) return null;

  const min = Number(match[2]);
  const max = match[3] === undefined ? min : Number(match[3]);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

/**
 * Maps an advanced-description header word to a mod kind. Prefixes and suffixes are both ordinary
 * explicit affixes as far as the trade stat reference is concerned; anything unrecognised is
 * treated as explicit too, since that is the largest group and the safest guess.
 */
function kindFromHeader(word: string): ModKind {
  const lower = word.toLowerCase();
  if (lower === "implicit") return "implicit";
  if (lower === "rune") return "rune";
  if (lower === "enchant" || lower === "enchanted") return "enchant";
  if (lower === "crafted") return "crafted";
  if (lower === "fractured") return "fractured";
  if (lower === "desecrated") return "desecrated";
  return "explicit";
}

function splitSections(rawText: string): string[] {
  return rawText
    .trim()
    .split(SECTION_SEPARATOR)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
}

function parseRarity(line: string): ItemRarity {
  const value = line.replace(/^Rarity:\s*/, "").trim();
  if (value === "Normal" || value === "Magic" || value === "Rare" || value === "Unique" || value === "Currency" || value === "Gem") {
    return value;
  }
  return "Normal";
}

function parseHeader(headerSection: string): {
  rarity: ItemRarity;
  name: string;
  baseType: string;
  itemClass: string | null;
} {
  const lines = headerSection.split(/\r?\n/).map((l) => l.trim());
  // Some items (e.g. Waystones) prefix the header with an "Item Class: X" line before "Rarity:",
  // so the rarity line isn't always line 0.
  const rarityIndex = lines.findIndex((line) => line.startsWith("Rarity:"));
  const start = rarityIndex === -1 ? 0 : rarityIndex;
  const rarity = parseRarity(lines[start] ?? "");
  const name = lines[start + 1] ?? "";
  const baseType = rarity === "Rare" || rarity === "Unique" ? (lines[start + 2] ?? name) : name;

  const classLine = lines.find((line) => line.startsWith("Item Class:"));
  const itemClass = classLine ? classLine.replace(/^Item Class:\s*/, "").trim() || null : null;

  return { rarity, name, baseType, itemClass };
}

/**
 * First capture group of `pattern` as a number, searched across every section. null if absent.
 * Thousands separators are stripped — large currency stacks are printed as "1,234/5,000".
 */
function findNumber(sections: string[], pattern: RegExp): number | null {
  for (const section of sections) {
    const match = section.match(pattern);
    if (match) {
      const value = Number(match[1].replace(/,/g, ""));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function parseStackSize(sections: string[]): number {
  return findNumber(sections, /^Stack Size:\s*([\d,]+)\s*\/\s*[\d,]+/m) ?? 1;
}

/**
 * A gem's own level line. Anchored and matched with `^Level:` specifically so it can't pick up
 * `Item Level:` or `Requires Level:`, which are different numbers on the same item.
 */
function parseGemLevel(sections: string[]): number | null {
  return findNumber(sections, /^Level:\s*(\d+)/m);
}

/**
 * The defence totals from the property block. These lines are also matched by `PROPERTY_LINE` and
 * therefore skipped by `parseMods` — read here instead, because the trade API indexes exactly these
 * numbers (`equipment_filters`) and they already have every local mod folded in by the game.
 *
 * A defence carrying any mod is printed as `Armour: 1081 (augmented)`; the suffix sits after the
 * digits, so no pattern has to know about it. `findNumber` scans every section, which matters —
 * the property block is not at a fixed index (gauntlets put `Item Level` above it, advanced
 * descriptions put it first).
 */
function parseDefences(sections: string[]): ItemDefences {
  return {
    armour: findNumber(sections, /^Armour:\s*([\d,]+)/m),
    evasion: findNumber(sections, /^Evasion Rating:\s*([\d,]+)/m),
    energyShield: findNumber(sections, /^Energy Shield:\s*([\d,]+)/m),
    ward: findNumber(sections, /^Runic Ward:\s*([\d,]+)/m)
  };
}

/**
 * A waystone's reward totals from the property block. Read for the same reason `parseDefences` is:
 * `PROPERTY_LINE` already keeps these lines out of the mod list, and they are the numbers GGG's
 * `map_filters` group indexes — produced by the affix set as a whole, not by any single mod.
 *
 * Printed as `Item Rarity: +24% (augmented)`, so the pattern has to allow a leading `+`; the `%` and
 * the `(augmented)` suffix both sit after the digits and need no handling. The wording is the
 * clipboard's, taken from a real capture — note `Pack Size:`, which the trade site calls
 * "Waystone Packsize", and `Revives Available:` rather than "Waystone Revives".
 */
function parseMapStats(sections: string[]): ItemMapStats {
  return {
    itemRarity: findNumber(sections, /^Item Rarity:\s*\+?([\d,]+)/m),
    packSize: findNumber(sections, /^Pack Size:\s*\+?([\d,]+)/m),
    monsterRarity: findNumber(sections, /^Monster Rarity:\s*\+?([\d,]+)/m),
    dropChance: findNumber(sections, /^Waystone Drop Chance:\s*\+?([\d,]+)/m),
    monsterEffectiveness: findNumber(sections, /^Monster Effectiveness:\s*\+?([\d,]+)/m),
    revives: findNumber(sections, /^Revives Available:\s*\+?([\d,]+)/m)
  };
}

/**
 * A weapon's elemental damage and attack rate, which multiply into the elemental DPS GGG indexes as
 * `equipment_filters.edps`.
 *
 * Read for the same reason `parseDefences` is: the game has already folded every `Adds # to #
 * Fire Damage` roll into the printed line, and that total is what the market is searched on — the
 * individual rolls pin numbers nobody else has.
 *
 * The line carries **one range per element**, comma separated, each able to take its own
 * `(augmented)` suffix: `Elemental Damage: 12-25 (augmented), 8-14 (augmented)`. So this can't go
 * through `findNumber`, which reads a single capture — the ranges are scanned out of the line and
 * averaged, since a range of 12-25 contributes 18.5 to the damage per hit GGG computes.
 *
 * Everything returns null when the line is absent, which is the ordinary case: only weapons print
 * either of these, and `weapon-stats.ts` reads null as "no constraint".
 */
function parseWeaponStats(sections: string[]): ItemWeaponStats {
  return {
    elementalDamage: parseElementalDamage(sections),
    attacksPerSecond: findNumber(sections, /^Attacks per Second:\s*([\d.]+)/m)
  };
}

/** Sum of the averages of every range on the `Elemental Damage:` line. null when there is none. */
function parseElementalDamage(sections: string[]): number | null {
  for (const section of sections) {
    const line = section.match(/^Elemental Damage:\s*(.+)$/m);
    if (!line) continue;

    let total = 0;
    let found = false;
    // Deliberately a global scan for `N-M` pairs rather than a split on commas: the separator between
    // ranges is the one part of this line's formatting not confirmed against a real capture, and
    // pulling the pairs out directly doesn't depend on it.
    for (const range of line[1].matchAll(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/g)) {
      total += (Number(range[1]) + Number(range[2])) / 2;
      found = true;
    }
    if (found) return total;
  }
  return null;
}

/** Rune/soul-core sockets, written as `Sockets: S S`. Counts the slot tokens. */
function parseSocketCount(sections: string[]): number | null {
  for (const section of sections) {
    const match = section.match(/^Sockets:\s*(.+)$/m);
    if (match) return match[1].trim().split(/\s+/).filter(Boolean).length;
  }
  return null;
}

function isCorrupted(sections: string[]): boolean {
  return sections.some((section) => section.trim() === "Corrupted");
}

function isIdentified(rawText: string): boolean {
  return !/^Unidentified$/m.test(rawText);
}

function parseMods(sections: string[], rarity: ItemRarity): ParsedMod[] {
  // Currency/gem/normal-rarity clipboard text has flavor/description lines with no colon
  // that would otherwise be mistaken for mod lines, and these rarities never carry
  // priced affixes, so skip mod parsing entirely.
  if (rarity === "Currency" || rarity === "Gem" || rarity === "Normal") return [];

  const mods: ParsedMod[] = [];

  // Split once. The header pass below reads the same lines the mod loop does, and re-splitting for it
  // would be one more place for the two to drift apart.
  const blocks = sections
    .slice(1)
    .map((section) => section.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));

  // With Advanced Item Descriptions on the game names every affix, so anything it did *not* name is
  // prose: a jewel's "Place into an allocated Jewel Socket ...", a waystone's map device line, a
  // unique's flavour text, a trailing "Unmodifiable". Believing the headers is what makes this one
  // rule rather than an `isKnownNonModLine` entry per item class, which is what it was becoming.
  //
  // Keyed on the whole item rather than per section, and that is the whole point. Those description
  // lines sit in their *own* trailing section with no header in it, so a per-section test would find
  // no headers there and go on taking every one of them for an affix.
  const headed = blocks.some((lines) => lines.some((line) => ADVANCED_MOD_HEADER.test(line)));

  for (const lines of blocks) {
    // A "{ ... Modifier ... }" header applies to every line under it until the next header. It does
    // not carry across a section break, so these reset per section rather than per item. Both travel
    // together because one header can cover several lines — a hybrid affix granting evasion *and*
    // energy shield is two mod lines off one roll, and they share its tier as well as its kind.
    let headerKind: ModKind = "explicit";
    let headerTier: number | null = null;
    let sawHeader = false;

    // Classified per line rather than per section. Requiring *every* line in a section to look
    // mod-like meant one property line sharing the block (PoE2 puts "Grants Skill: ..." next to
    // real affixes) silently discarded the entire affix list.
    for (const line of lines) {
      const header = line.match(ADVANCED_MOD_HEADER);
      if (header) {
        headerKind = kindFromHeader(header[1]);
        const tier = header[2].match(MOD_TIER);
        headerTier = tier ? Number(tier[1]) : null;
        sawHeader = true;
        continue;
      }
      if (PROPERTY_LINE.test(line) || isKnownNonModLine(line)) continue;

      // An explicit "(rune)"-style marker beats the enclosing header: rune lines sit in their own
      // section above the "{ ... }" blocks and carry no header of their own. It takes the tier with
      // it — whatever header is in scope demonstrably isn't describing this line.
      const suffix = line.match(MOD_KIND_SUFFIX);

      // An item that names its affixes has nothing unnamed that is still a mod — except a rune, which
      // prints no header of its own and says so with the suffix instead. That escape is load-bearing
      // rather than defensive: without it every runeforged item silently loses its rune, which is a
      // far worse failure than the stray description line this gate exists to drop.
      if (headed && !sawHeader && !suffix) continue;

      const body = line.replace(MOD_KIND_SUFFIX, "");
      mods.push({
        text: stripRollRanges(body).trim(),
        kind: suffix ? (suffix[1].toLowerCase() as ModKind) : headerKind,
        tier: suffix ? null : headerTier,
        // Read before the stripping throws it away. Unlike `tier` this is kept even on a rune line:
        // the bracket is printed by the roll itself rather than by a header, so the suffix that
        // invalidates the header's tier says nothing about it.
        rollRange: parseRollRange(body)
      });
    }
  }

  return mods;
}

function isKnownNonModLine(line: string): boolean {
  return (
    line === "Corrupted" ||
    line === "Unidentified" ||
    // Standalone status keywords that sit in their own section with no colon, so nothing else here
    // excludes them and they'd otherwise be offered as mods to tick off in the row editor.
    line === "Unmodifiable" ||
    line === "Mirrored" ||
    line === "Split" ||
    /^Item Level:/.test(line) ||
    /^Requires Level/.test(line) ||
    /^Sockets:/.test(line) ||
    /^Stack Size:/.test(line) ||
    // Usage instructions ("Right click to add this to your map device."). These sit in their own
    // section on waystones and tablets, and per-line classification would otherwise take them
    // for affixes now that the section no longer has to be uniformly mod-like.
    /^(Right|Left|Shift) click/i.test(line) ||
    // The other wording of the same thing, and it has no colon either, so PROPERTY_LINE misses it
    // too: "Can be used in a Map Device, allowing you to enter a Map. Waystones can only be used
    // once." was being stored as an explicit mod on every waystone and offered in the row editor as
    // something to untick.
    /^Can be used in a Map Device/i.test(line) ||
    // "Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the
    // Socket." — the click guard above misses it because that phrase is only its *second* sentence,
    // so it was stored as an explicit mod on every jewel and offered in the row editor to untick.
    //
    // The header gate in `parseMods` catches this first whenever Advanced Item Descriptions is on.
    // This list is the fallback for captures made without the option, where there are no headers to
    // believe and rejecting prose by name is the only thing left.
    /^Place into /i.test(line)
  );
}

export function parseItemText(rawText: string): ParsedItem | null {
  const sections = splitSections(rawText);
  if (sections.length === 0) return null;

  const { rarity, name, baseType, itemClass } = parseHeader(sections[0]);
  const mods = parseMods(sections, rarity);

  return {
    rawText,
    rarity,
    name,
    baseType,
    itemClass,
    stackSize: parseStackSize(sections),
    itemLevel: findNumber(sections, /^Item Level:\s*(\d+)/m),
    quality: findNumber(sections, /^Quality:\s*\+?(\d+)%/m),
    gemLevel: parseGemLevel(sections),
    waystoneTier: findNumber(sections, /^Waystone Tier:\s*(\d+)/m),
    socketCount: parseSocketCount(sections),
    defences: parseDefences(sections),
    weapon: parseWeaponStats(sections),
    mapStats: parseMapStats(sections),
    identified: isIdentified(rawText),
    corrupted: isCorrupted(sections),
    mods,
    // Flattened views of `mods`, kept for the store, the row editor and `ignoredMods`. Everything
    // that isn't implicit lands in explicitMods, which is what this produced before kinds existed.
    implicitMods: mods.filter((mod) => mod.kind === "implicit").map((mod) => mod.text),
    explicitMods: mods.filter((mod) => mod.kind !== "implicit").map((mod) => mod.text),
    capturedAt: Date.now()
  };
}
