# The item text parser

`src/parser/item-text-parser.ts` — step 2 of the data flow, turning PoE2's Ctrl+C clipboard text
into a `ParsedItem`. Read before changing mod, defence or weapon-stat parsing.

Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---

2. `parseItemText()` (`src/parser/item-text-parser.ts`) turns the raw clipboard text into a
   `ParsedItem` (rarity/name/baseType/mods/etc.), splitting on `-{5,}` dashed section separators.
   Mod parsing is skipped entirely for Currency/Gem/Normal rarity to avoid false-positive matches
   against flavor text.

   **It must handle PoE2's "Advanced Item Descriptions" option**, which many players run with and
   which changes the mod format substantially. Four things it adds, all handled and none optional:
   - `{ Prefix Modifier "Polar" (Tier: 1) — Elemental, Cold }` grouping headers. These are not mods;
     they classify the lines *under* them, until the next header or the end of the section. Two
     things are read off one: the leading word, which gives the `ModKind`, and `(Tier: N)`, which
     gives `ParsedMod.tier` and is the **only** source of affix tier anywhere in the app — GGG's stat
     reference publishes none. One header can cover several lines (a hybrid affix is one roll printed
     as two), and they share its tier as well as its kind, so both travel together. A trailing
     `(rune)`-style marker overrides the kind and takes the tier to null with it: a header that isn't
     describing this line's kind isn't describing its tier either.
   - The roll range spliced into the number itself — `Attacks Gain 20(19-20)% of Damage`. GGG's stat
     templates carry a bare `#` and `TradeStatsMatcher` anchors end to end, so a range left in place
     matches **nothing**. This alone silently reduced every rare to a base-type-only trade search.
     It is stripped from `text` but **kept** on `ParsedMod.rollRange`, from the line's *first* number
     — the one the matcher captures and filters on. That bracket is the only thing separating "rolled
     the top of its tier" from "rolled the bottom", and `searchFloor()` is what reads it.
   - `Unmodifiable` and similar bare status keywords, which have no colon and would otherwise be
     offered as mods to tick off in the row editor.
   - **The headers are authoritative, not merely tolerated.** Once an item prints any of them the
     game has named every affix it has, so `parseMods` treats an unnamed line as prose and drops it:
     a jewel's "Place into an allocated Jewel Socket ...", a waystone's map device line, a unique's
     flavour text. This replaced a blocklist that was growing one wording per item class, and had
     already missed the jewel line twice over — no colon, so `PROPERTY_LINE` skipped it, and the
     "Right click" phrase is only its *second* sentence, so the click guard skipped it too.

     Three things about the gate are load-bearing. It is armed **per item, not per section**: those
     description lines sit in their own trailing section with no header in it, so a per-section test
     finds no headers there and goes on treating every one of them as an affix — the exact bug. A
     line carrying a `(rune)`-style **suffix is exempt**, because a rune prints no header of its own
     and that marker is the only thing identifying it; without the exemption every runeforged item
     silently loses its rune, which is far worse than the stray line the gate exists to drop. And
     `isKnownNonModLine` **stays** — it is the whole guard for a capture made *without* the option,
     where there are no headers to believe.

   Mods carry a `ModKind` (`ParsedItem.mods`); `implicitMods`/`explicitMods` are flattened views of
   it, kept because they are what the store, the row editor and `ignoredMods` already use. Read
   through `modsOf()` (`src/shared/mods.ts`) — items persisted before `mods` existed have only the
   arrays, and nothing migrates `loot-cache.json` on load.

   It also reads the **defence totals** out of the property block into `ParsedItem.defences`
   (`Armour:`, `Evasion Rating:`, `Energy Shield:`, `Runic Ward:`). Those lines match
   `PROPERTY_LINE` and are skipped by `parseMods`, so they used to be discarded entirely — but they
   are the numbers GGG's trade API indexes, with every local mod and the item's quality already
   folded in by the game. Read them through `defencesOf()` (`src/shared/defences.ts`) for the same
   reason as `modsOf()`. `Runic Ward` is a distinct defence on runeforged bases, not a synonym for
   energy shield, and has its own filter id.

   The same goes for a weapon's `Elemental Damage:` and `Attacks per Second:` lines, into
   `ParsedItem.weapon` and read through `weaponStatsOf()` (`src/shared/weapon-stats.ts`). Two
   differences from the defences: the damage line carries **one range per element**, comma separated,
   so it is scanned for `N-M` pairs and averaged rather than read with a single capture; and neither
   number is a filter on its own — their product is, as `equipment_filters.edps`.

---

## Non-goals / do not "fix"

- `ParsedItem.mods` duplicating `implicitMods`/`explicitMods` is deliberate — see the parser notes
  above. Don't "deduplicate" it by deleting the arrays; they are the persisted shape.
- `isKnownNonModLine` surviving alongside the header gate is not dead code. The gate only arms when
  the item printed headers, so without that list a capture made without **Advanced Item Descriptions**
  has nothing rejecting its usage-instruction lines. Don't delete an entry on the grounds that the
  gate already covers it — it covers it for one half of the player base.
- Nothing migrates `loot-cache.json`, so items captured **before** a parser fix keep whatever they
  were stored with; Reprice re-reads the stored `mods` rather than reparsing. A jewel picked up
  before the gate existed still shows its socket-instruction row until it is picked up again. Don't
  paper over that by filtering in `modsOf()` — that duplicates parser rules into `shared/` for a
  cosmetic gain on historical rows.
