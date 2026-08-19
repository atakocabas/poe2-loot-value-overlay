import assert from "node:assert/strict";
import { test } from "node:test";
import { PoeNinjaClient, slugVariants, slugify } from "../pricing/poeninja-client";
import type { Settings } from "../shared/settings";
import type { ParsedItem } from "../shared/types";
import { parseItemText } from "../parser/item-text-parser";

function makeParsedItem(name: string, overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    rawText: "",
    rarity: "Currency",
    name,
    baseType: name,
    itemClass: null,
    stackSize: 1,
    itemLevel: null,
    quality: null,
    gemLevel: null,
    waystoneTier: null,
    socketCount: null,
    defences: { armour: null, evasion: null, energyShield: null, ward: null },
    weapon: { elementalDamage: null, attacksPerSecond: null },
    mapStats: {
      itemRarity: null,
      packSize: null,
      monsterRarity: null,
      dropChance: null,
      monsterEffectiveness: null,
      revives: null
    },
    identified: true,
    corrupted: false,
    mods: [],
    implicitMods: [],
    explicitMods: [],
    capturedAt: Date.now(),
    ...overrides
  };
}

// Rates copied from a live response: primaryValue is in divine, rates.chaos is chaos-per-divine.
const CORE = { rates: { exalted: 382.2, chaos: 7.83 }, primary: "divine", secondary: "chaos" };

const FIXTURES: Record<string, { core?: typeof CORE; lines?: unknown[] }> = {
  Currency: {
    core: CORE,
    lines: [
      { id: "chaos", primaryValue: 0.1276 },
      { id: "divine", primaryValue: 1 },
      { id: "alch", primaryValue: 0.002 },
      { id: "artificers", primaryValue: 0.004 },
      { id: "transmute", primaryValue: 0.0001 }
    ]
  },
  Ritual: {
    core: CORE,
    lines: [
      { id: "omen-of-chaotic-monsters", primaryValue: 0.5 },
      { id: "omen-of-gambling", primaryValue: 0.25 }
    ]
  },
  Runes: {
    core: CORE,
    lines: [{ id: "countess-seskes-rune-of-archery", primaryValue: 0.1 }]
  },
  // Both ids are copied verbatim from the live feed, accents and all: poe.ninja folds the one and
  // keeps the other, which is why a lookup has to try each spelling.
  LineageSupportGems: {
    core: CORE,
    lines: [
      { id: "oisins-oath", primaryValue: 0.006267 },
      { id: "mórrigans-insight", primaryValue: 0.004 }
    ]
  },
  // Ids copied from a live response: uncut gems are listed once per level, not once per name.
  UncutGems: {
    core: CORE,
    lines: [
      { id: "uncut-skill-gem-16", primaryValue: 0.002366 },
      { id: "uncut-skill-gem-20", primaryValue: 5.84 },
      { id: "uncut-spirit-gem-13", primaryValue: 0.09235 },
      { id: "uncut-support-gem-1", primaryValue: 0.007895 },
      { id: "uncut-support-gem-5", primaryValue: 0.01645 }
    ]
  },
  // An unknown/renamed category: poe.ninja answers 200 with no core and no lines.
  Ultimatum: { lines: [] },
  // A core block with no chaos rate. Accepting this would store raw divine values as chaos.
  Verisium: {
    core: { rates: { exalted: 382.2 }, primary: "divine", secondary: "chaos" } as typeof CORE,
    lines: [{ id: "verisium-ore", primaryValue: 0.01 }]
  },
  UniqueWeapons: {
    core: CORE,
    lines: [
      { name: "The Sentry", baseType: "Runemastered Gothic Quarterstaff", primaryValue: 0.1215 },
      { name: "The Sentry", baseType: "Runeforged Gothic Quarterstaff", primaryValue: 0.00723 },
      { name: "The Sentry", baseType: "Gothic Quarterstaff", primaryValue: 0.00258 },
      { name: "Redbeak", baseType: "Shortsword", primaryValue: 4251 }
    ]
  }
};

function makeClient(itemTypes: string[], exchangeTypes: string[]): PoeNinjaClient {
  const settings = {
    league: "Runes of Aldur",
    poeNinja: {
      baseUrl: "https://poe.ninja/poe2/api/economy",
      refreshIntervalMs: 900000,
      itemOverviewTypes: itemTypes,
      exchangeOverviewTypes: exchangeTypes
    }
  } as Settings;

  const fetchStub = (async (input: URL | RequestInfo) => {
    const type = new URL(String(input)).searchParams.get("type") ?? "";
    const body = FIXTURES[type];
    if (!body) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  return new PoeNinjaClient(settings, fetchStub);
}

test("slugify reconstructs poe.ninja ids from display names", () => {
  assert.equal(slugify("Omen of Chaotic Monsters"), "omen-of-chaotic-monsters");
  assert.equal(slugify("Countess Seske's Rune of Archery"), "countess-seskes-rune-of-archery");
  assert.equal(slugify("The Trialmaster's Reliquary Key"), "the-trialmasters-reliquary-key");
  assert.equal(slugify("Perfect Essence of Battle"), "perfect-essence-of-battle");
  // Curly apostrophes appear in some clipboard text.
  assert.equal(slugify("Artificer’s Orb"), "artificers-orb");
});

test("accents are folded rather than turned into separators", () => {
  // "ois-ns-oath" is what this produced before, and it matched nothing: the item went unpriced
  // although poe.ninja lists it as "oisins-oath".
  assert.equal(slugify("Oisín's Oath"), "oisins-oath");
  assert.equal(slugify("Mjölner"), "mjolner");
});

test("both accent spellings are offered, because poe.ninja's own ids use both", () => {
  // Live Runes of Aldur data has "oisins-oath" and "mórrigans-insight" in the same category.
  assert.deepEqual(slugVariants("Oisín's Oath"), ["oisins-oath", "oisíns-oath"]);
  assert.deepEqual(slugVariants("Mórrigan's Insight"), ["morrigans-insight", "mórrigans-insight"]);
  // An ASCII name has nothing to disagree about and yields a single candidate.
  assert.deepEqual(slugVariants("Perfect Essence of Battle"), ["perfect-essence-of-battle"]);
});

test("an accented name is priced whichever spelling poe.ninja's id uses", async () => {
  const client = makeClient([], ["LineageSupportGems"]);
  await client.refresh();

  // Priced at "ois-ns-oath" before, which matched nothing and read as a missing category.
  assert.ok(client.getChaosValueForItem(makeParsedItem("Oisín's Oath")) !== null);
  assert.ok(client.getChaosValueForItem(makeParsedItem("Mórrigan's Insight")) !== null);
});

test("Chaos Orb resolves to ~1 chaos, guarding the conversion direction", async () => {
  const client = makeClient([], ["Currency"]);
  await client.refresh();

  const value = client.getChaosValue("Chaos Orb");
  assert.ok(value !== null && Math.abs(value - 1) < 0.01, `expected ~1 chaos, got ${value}`);
});

test("an omen is priced by slugified name from the Ritual category", async () => {
  const client = makeClient([], ["Ritual"]);
  await client.refresh();

  assert.equal(client.getChaosValue("Omen of Chaotic Monsters"), 0.5 * 7.83);
});

test("currencies whose ids are irregular abbreviations still resolve", async () => {
  const client = makeClient([], ["Currency"]);
  await client.refresh();

  assert.equal(client.getChaosValue("Orb of Alchemy"), 0.002 * 7.83);
  assert.equal(client.getChaosValue("Artificer's Orb"), 0.004 * 7.83);
  assert.equal(client.getChaosValue("Orb of Transmutation"), 0.0001 * 7.83);
});

test("a unique with base variants is priced by its own base type", async () => {
  const client = makeClient(["UniqueWeapons"], []);
  await client.refresh();

  assert.equal(client.getChaosValue("The Sentry", "Runemastered Gothic Quarterstaff"), 0.1215 * 7.83);
  assert.equal(client.getChaosValue("The Sentry", "Runeforged Gothic Quarterstaff"), 0.00723 * 7.83);
  assert.equal(client.getChaosValue("The Sentry", "Gothic Quarterstaff"), 0.00258 * 7.83);
});

test("an unrecognised base type falls back to the cheapest same-name variant", async () => {
  const client = makeClient(["UniqueWeapons"], []);
  await client.refresh();

  assert.equal(client.getChaosValue("The Sentry", "Some Unlisted Quarterstaff"), 0.00258 * 7.83);
  assert.equal(client.getChaosValue("The Sentry"), 0.00258 * 7.83);
});

test("repeated refreshes do not ratchet a same-name price downwards", async () => {
  const client = makeClient(["UniqueWeapons"], []);
  await client.refresh();
  await client.refresh();
  await client.refresh();

  assert.equal(client.getChaosValue("The Sentry", "Runemastered Gothic Quarterstaff"), 0.1215 * 7.83);
  assert.equal(client.getChaosValue("The Sentry"), 0.00258 * 7.83);
});

test("a category returning no lines neither throws nor poisons the cache", async () => {
  const client = makeClient([], ["Currency", "Ultimatum"]);
  await client.refresh();

  assert.equal(client.getChaosValue("Nonexistent Thing"), null);
  const chaos = client.getChaosValue("Chaos Orb");
  assert.ok(chaos !== null && Math.abs(chaos - 1) < 0.01);
});

test("a failing category leaves the other categories' prices intact", async () => {
  const client = makeClient([], ["Currency", "NoSuchType"]);
  await client.refresh();

  const chaos = client.getChaosValue("Chaos Orb");
  assert.ok(chaos !== null && Math.abs(chaos - 1) < 0.01);
});

test("a category with no chaos conversion rate is skipped, not stored in divine", async () => {
  const client = makeClient([], ["Currency", "Verisium"]);
  await client.refresh();

  // 0.01 divine is ~0.08 chaos; storing it unconverted would report 0.01 and understate it ~8x.
  assert.equal(client.getChaosValue("Verisium Ore"), null);
  const chaos = client.getChaosValue("Chaos Orb");
  assert.ok(chaos !== null && Math.abs(chaos - 1) < 0.01);
});

/**
 * Built by running real clipboard text through the parser rather than hand-writing a ParsedItem.
 * An invented fixture ("Uncut Skill Gem" plus a separate gemLevel) is exactly what let a broken
 * name->id mapping ship: PoE2 actually writes the level into the name, as "Uncut Skill Gem
 * (Level 20)", so the hand-built object tested a string the game never produces.
 */
function parseFixture(rawText: string): ParsedItem {
  const item = parseItemText(rawText);
  assert.ok(item, "fixture failed to parse");
  return item!;
}

function uncutGem(name: string): ParsedItem {
  return parseFixture(
    `Item Class: Skill Gems\nRarity: Currency\n${name}\n--------\n` +
      `Right click to view all Skill Gems you can create.`
  );
}

test("an uncut gem is priced by the level baked into its name", async () => {
  const client = makeClient([], ["UncutGems"]);
  await client.refresh();

  const at20 = client.getChaosValueForItem(uncutGem("Uncut Skill Gem (Level 20)"));
  const at16 = client.getChaosValueForItem(uncutGem("Uncut Skill Gem (Level 16)"));
  assert.equal(at20, 5.84 * 7.83);
  assert.equal(at16, 0.002366 * 7.83);
  assert.ok(at20! > at16! * 1000, "the level spread is the whole point of routing on it");

  assert.equal(client.getChaosValueForItem(uncutGem("Uncut Spirit Gem (Level 13)")), 0.09235 * 7.83);
  // The case seen in the wild that went unpriced.
  assert.equal(client.getChaosValueForItem(uncutGem("Uncut Support Gem (Level 5)")), 0.01645 * 7.83);
});

test("a level from a separate property line still resolves", async () => {
  const client = makeClient([], ["UncutGems"]);
  await client.refresh();

  // Not every levelled item names its level; keep the property-line path working too.
  assert.equal(
    client.getChaosValueForItem(makeParsedItem("Uncut Support Gem", { gemLevel: 1 })),
    0.007895 * 7.83
  );
  assert.equal(
    client.getChaosValueForItem(makeParsedItem("Uncut Skill Gem", { itemLevel: 20 })),
    5.84 * 7.83
  );
});

test("a gem level poe.ninja does not list falls back to the plain name lookup", async () => {
  const client = makeClient([], ["UncutGems", "Currency"]);
  await client.refresh();

  assert.equal(client.getChaosValueForItem(uncutGem("Uncut Skill Gem (Level 7)")), null);
  // A levelled non-gem must not be knocked off the normal path by the level suffix probe.
  const chaos = client.getChaosValueForItem(makeParsedItem("Chaos Orb", { itemLevel: 82 }));
  assert.ok(chaos !== null && Math.abs(chaos - 1) < 0.01);
});

test("an item poe.ninja does not list resolves to null", async () => {
  const client = makeClient(["UniqueWeapons"], ["Currency"]);
  await client.refresh();

  assert.equal(client.getChaosValue("Iron Charge", "Iron Greaves"), null);
});

/**
 * A refresh is one request per category and poe.ninja publishes no rate limits — so unlike the GGG
 * hosts there is no header to react to and the only lever is not bursting in the first place. These
 * two cover that lever: the pool, and saying who is calling.
 */
function makeInstrumentedClient(
  types: string[],
  poeNinjaOverrides: Record<string, unknown> = {},
  settingsOverrides: Record<string, unknown> = {}
): { client: PoeNinjaClient; inFlightPeak: () => number; headers: () => Array<Record<string, string>> } {
  const settings = {
    league: "Runes of Aldur",
    poeNinja: {
      baseUrl: "https://poe.ninja/poe2/api/economy",
      refreshIntervalMs: 900000,
      maxConcurrentRequests: 4,
      itemOverviewTypes: [],
      exchangeOverviewTypes: types,
      ...poeNinjaOverrides
    },
    ...settingsOverrides
  } as unknown as Settings;

  let inFlight = 0;
  let peak = 0;
  const headers: Array<Record<string, string>> = [];

  const fetchStub = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    headers.push((init?.headers ?? {}) as Record<string, string>);
    inFlight++;
    peak = Math.max(peak, inFlight);
    // A real turn of the event loop, so overlapping requests actually overlap.
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight--;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;

  return { client: new PoeNinjaClient(settings, fetchStub), inFlightPeak: () => peak, headers: () => headers };
}

test("a refresh never has more requests in flight than the configured pool", async () => {
  const types = Array.from({ length: 12 }, (_, i) => `Type${i}`);
  const { client, inFlightPeak } = makeInstrumentedClient(types, { maxConcurrentRequests: 3 });

  await client.refresh();

  assert.equal(inFlightPeak(), 3, "12 categories must not all be fired at a free API at once");
});

test("the pool spans both category lists rather than allowing one each", async () => {
  // Measured against the live API before this was one pool: a configured 4 ran 8 requests in
  // flight, because the item and exchange lists each had their own. The limit has to mean the
  // refresh, or it doesn't mean anything a user can reason about.
  const { client, inFlightPeak } = makeInstrumentedClient([], {
    maxConcurrentRequests: 3,
    itemOverviewTypes: Array.from({ length: 6 }, (_, i) => `Item${i}`),
    exchangeOverviewTypes: Array.from({ length: 6 }, (_, i) => `Exchange${i}`)
  });

  await client.refresh();

  assert.equal(inFlightPeak(), 3);
});

test("an unusable concurrency value costs concurrency, never the whole refresh", async () => {
  // `Math.max(1, undefined)` is NaN, `slice(0, NaN)` is empty, and the loop then exits on its first
  // pass — a refresh that silently fetches nothing and reads as poe.ninja being down.
  const types = Array.from({ length: 6 }, (_, i) => `Type${i}`);
  const { client, inFlightPeak, headers } = makeInstrumentedClient(types, {
    maxConcurrentRequests: undefined
  });

  await client.refresh();

  assert.equal(headers().length, 6, "every category must still be fetched");
  assert.ok(inFlightPeak() >= 1);
});

test("overlapping refreshes share one pull rather than each opening a pool", async () => {
  // What the panel's Refresh button made reachable: a press can land on top of the 10-minute timer,
  // or on top of a previous press. Each concurrent call used to open its own pool, so two refreshes
  // ran at twice the configured concurrency — the same failure "one pool over both lists" guards
  // against, arriving by another route.
  const types = Array.from({ length: 6 }, (_, i) => `Type${i}`);
  const { client, inFlightPeak, headers } = makeInstrumentedClient(types, { maxConcurrentRequests: 3 });

  await Promise.all([client.refresh(), client.refresh(), client.refresh()]);

  assert.equal(headers().length, 6, "three callers, one pull of the six categories");
  assert.equal(inFlightPeak(), 3, "and the pool is still the configured pool");
});

test("the guard releases, so the next refresh after one settles really refreshes", async () => {
  // A latched guard would look identical until the prices went stale and nothing could renew them.
  const types = Array.from({ length: 6 }, (_, i) => `Type${i}`);
  const { client, headers } = makeInstrumentedClient(types, { maxConcurrentRequests: 3 });

  await client.refresh();
  await client.refresh();

  assert.equal(headers().length, 12);
});

test("every poe.ninja request names the app, and the contact when one is configured", async () => {
  const { client, headers } = makeInstrumentedClient(["Currency"], {}, {
    trade2: { contactEmail: "someone@example.com" }
  });

  await client.refresh();

  const agent = headers()[0]["User-Agent"];
  assert.match(agent, /^PoE2LootValueOverlay\/\d/);
  assert.match(agent, /\(contact: someone@example\.com\)$/);
});

test("no configured contact leaves the clause off rather than sending an empty one", async () => {
  // The address is asked for during setup and is legitimately absent until then; `(contact: )`
  // identifies nobody and is a malformed header into the bargain.
  const { client, headers } = makeInstrumentedClient(["Currency"], {}, {
    trade2: { contactEmail: "  " }
  });

  await client.refresh();

  assert.doesNotMatch(headers()[0]["User-Agent"], /contact/);
});
