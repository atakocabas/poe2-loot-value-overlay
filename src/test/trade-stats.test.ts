import assert from "node:assert/strict";
import { test } from "node:test";
import { TradeStatsMatcher } from "../pricing/trade-stats";
import type { GggFetch } from "../pricing/ggg-fetch";
import type { ParsedMod } from "../shared/types";

/**
 * "#% increased Armour" deliberately appears in three groups with three different ids — that is
 * the real shape of GGG's data, where `crafted`/`fractured`/`desecrated` are complete display-text
 * subsets of `explicit`, and it's what makes group routing load-bearing rather than cosmetic.
 */
const FIXTURE_STATS = {
  result: [
    {
      id: "explicit",
      entries: [
        { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
        { id: "explicit.stat_4220027924", text: "#% to Cold Resistance", type: "explicit" },
        { id: "explicit.stat_ARMOUR", text: "#% increased Armour", type: "explicit" },
        // GGG publishes the identical notable text under explicit, crafted and fractured as well as
        // enchant, and only the enchant ids are indexed against real listings. This entry is what
        // makes the routing test below mean something.
        { id: "explicit.stat_2954116742|57190", text: "Allocates Doomsayer", type: "explicit" }
      ]
    },
    {
      id: "implicit",
      entries: [{ id: "implicit.stat_1671376347", text: "#% to Lightning Resistance", type: "implicit" }]
    },
    { id: "rune", entries: [{ id: "rune.stat_ARMOUR", text: "#% increased Armour", type: "rune" }] },
    { id: "crafted", entries: [{ id: "crafted.stat_ARMOUR", text: "#% increased Armour", type: "crafted" }] },
    {
      id: "enchant",
      entries: [
        { id: "enchant.stat_2954116742|57190", text: "Allocates Doomsayer", type: "enchant" }
      ]
    },
    { id: "fractured", entries: [] },
    { id: "desecrated", entries: [] }
  ]
};

function stubGggFetch(): GggFetch {
  return async () => new Response(JSON.stringify(FIXTURE_STATS), { status: 200 });
}

const mod = (text: string, kind: ParsedMod["kind"] = "explicit"): ParsedMod => ({ text, kind });

test("matches a flat explicit mod line to its stat id and value", async () => {
  const matcher = new TradeStatsMatcher(stubGggFetch());
  const { matched, unmatched } = await matcher.matchMods([mod("+80 to maximum Life")]);

  assert.equal(matched.get("+80 to maximum Life")?.statId, "explicit.stat_3299347043");
  assert.equal(matched.get("+80 to maximum Life")?.value, 80);
  assert.deepEqual(unmatched, []);
});

test("matches a percentage explicit mod line", async () => {
  const matcher = new TradeStatsMatcher(stubGggFetch());
  const { matched } = await matcher.matchMods([mod("+45% to Cold Resistance")]);

  assert.equal(matched.get("+45% to Cold Resistance")?.value, 45);
});

test("an instilled notable resolves to the enchant id even when parsed as explicit", async () => {
  // **Measured live on `accessory.amulet`**: `enchant.stat_2954116742|57190` matched 1167 listings
  // and `explicit.stat_2954116742|57190` matched 0. Without Advanced Item Descriptions the parser
  // has no header to read and tags the line explicit, so the ordinary "own group first" routing
  // would pick the dead id — and since every rung is an `and`, one dead filter takes the whole
  // search to zero and the row reads as though the item had no market.
  const matcher = new TradeStatsMatcher(stubGggFetch());
  const { matched } = await matcher.matchMods([mod("Allocates Doomsayer")]);

  assert.equal(matched.get("Allocates Doomsayer")?.statId, "enchant.stat_2954116742|57190");
  // No `#` in the template, so it is asked for by presence and carries no threshold.
  assert.equal(matched.get("Allocates Doomsayer")?.value, null);
});

test("a notable parsed as an enchant lands on the same id", async () => {
  const matcher = new TradeStatsMatcher(stubGggFetch());
  const { matched } = await matcher.matchMods([mod("Allocates Doomsayer", "enchant")]);

  assert.equal(matched.get("Allocates Doomsayer")?.statId, "enchant.stat_2954116742|57190");
});

test("matches an implicit mod line against the implicit stat group", async () => {
  const matcher = new TradeStatsMatcher(stubGggFetch());
  const { matched } = await matcher.matchMods([mod("+20% to Lightning Resistance", "implicit")]);

  assert.equal(matched.get("+20% to Lightning Resistance")?.statId, "implicit.stat_1671376347");
});

test("identical text resolves to the id of the mod's own group, not whichever came first", async () => {
  const matcher = new TradeStatsMatcher(stubGggFetch());
  const line = "18% increased Armour";

  const asRune = await matcher.matchMods([mod(line, "rune")]);
  const asCrafted = await matcher.matchMods([mod(line, "crafted")]);
  const asExplicit = await matcher.matchMods([mod(line, "explicit")]);

  // Without kind routing all three would come back as explicit.stat_ARMOUR, and two of the three
  // searches would then filter for a mod the item doesn't actually have.
  assert.equal(asRune.matched.get(line)?.statId, "rune.stat_ARMOUR");
  assert.equal(asCrafted.matched.get(line)?.statId, "crafted.stat_ARMOUR");
  assert.equal(asExplicit.matched.get(line)?.statId, "explicit.stat_ARMOUR");
});

test("a kind with no entry of its own falls back to explicit rather than going unmatched", async () => {
  const matcher = new TradeStatsMatcher(stubGggFetch());
  const { matched } = await matcher.matchMods([mod("+80 to maximum Life", "fractured")]);

  assert.equal(matched.get("+80 to maximum Life")?.statId, "explicit.stat_3299347043");
});

test("reports mod lines with no matching stat as unmatched", async () => {
  const matcher = new TradeStatsMatcher(stubGggFetch());
  const { matched, unmatched } = await matcher.matchMods([
    mod("Socketed Gems are Supported by Level 20 Fire Penetration")
  ]);

  assert.equal(matched.size, 0);
  assert.deepEqual(unmatched, ["Socketed Gems are Supported by Level 20 Fire Penetration"]);
});

test("degrades gracefully when the stats endpoint is unreachable", async () => {
  const failingFetch: GggFetch = async () => {
    throw new Error("network down");
  };
  const matcher = new TradeStatsMatcher(failingFetch);
  const { matched, unmatched } = await matcher.matchMods([mod("+80 to maximum Life")]);

  assert.equal(matched.size, 0);
  assert.deepEqual(unmatched, ["+80 to maximum Life"]);
});
