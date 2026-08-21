import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHAOS_ID,
  DIVINE_ID,
  EXALTED_ID,
  CurrencyExchangeClient,
  buildChaosIndex,
  centralRatio,
  seedHour,
  type ExchangeMarket
} from "../pricing/currency-exchange-client";
import { metadataIdForName } from "../pricing/exchange-metadata-ids";
import type { Settings } from "../shared/settings";
import type { ParsedItem } from "../shared/types";

const LEAGUE = "Runes of Aldur";
const VAAL_ID = "Metadata/Items/Currency/CurrencyCorrupt";

function market(
  pair: [string, string],
  low: [number, number],
  high: [number, number],
  volume: [number, number],
  league = LEAGUE
): ExchangeMarket {
  const [a, b] = pair;
  return {
    league,
    market_id: `${a}|${b}`,
    market_pair: pair,
    volume_traded: { [a]: volume[0], [b]: volume[1] },
    lowest_ratio: { [a]: low[0], [b]: low[1] },
    highest_ratio: { [a]: high[0], [b]: high[1] }
  };
}

/**
 * The real chaos/divine market as returned by the live feed: 4 chaos per divine at the hour's low,
 * 5 at its high. Anchoring on captured data rather than invented numbers is what makes the
 * orientation assertions below meaningful.
 */
const CHAOS_DIVINE = market([CHAOS_ID, DIVINE_ID], [4, 1], [5, 1], [43546, 10883]);

function makeSettings(overrides: Partial<Settings["currencyExchange"]> = {}): Settings {
  return {
    league: LEAGUE,
    currencyExchange: {
      enabled: true,
      baseUrl: "https://example.invalid/currency-exchange",
      realm: "poe2",
      lookbackHours: 2,
      maxPagesPerRefresh: 4,
      refreshIntervalMs: 3600000,
      minVolume: 20,
      stalePoeNinjaAfterMs: 3600000,
      leagueOverride: "",
      ...overrides
    }
  } as unknown as Settings;
}

function item(name: string): ParsedItem {
  return { name, baseType: name, gemLevel: null, itemLevel: null } as unknown as ParsedItem;
}

test("a ratio pair is read in the direction the feed publishes it", () => {
  // lowest 4:1 and highest 5:1 chaos-per-divine -> geometric mean sqrt(20) ~= 4.472.
  assert.equal(centralRatio(CHAOS_DIVINE, DIVINE_ID, CHAOS_ID)?.toFixed(4), Math.sqrt(20).toFixed(4));
  // ...and the reciprocal in the other direction, never the same number.
  assert.equal(centralRatio(CHAOS_DIVINE, CHAOS_ID, DIVINE_ID)?.toFixed(4), (1 / Math.sqrt(20)).toFixed(4));
});

test("the hour's low and high collapse geometrically, not arithmetically", () => {
  // The live Vaal/divine market spanned 6..28 per divine in a single hour. The arithmetic mean (17)
  // sits far above the typical trade; the geometric mean (~12.96) is the defensible centre.
  const vaal = market([VAAL_ID, DIVINE_ID], [6, 1], [28, 1], [157, 30]);
  const price = centralRatio(vaal, DIVINE_ID, VAAL_ID);

  assert.equal(price?.toFixed(3), Math.sqrt(6 * 28).toFixed(3));
  assert.ok(price! < 17, "must not be the arithmetic mean");
});

test("a market missing one side of the ratio is skipped rather than producing NaN", () => {
  const broken: ExchangeMarket = { ...CHAOS_DIVINE, highest_ratio: { [CHAOS_ID]: 5 } };
  assert.equal(centralRatio(broken, DIVINE_ID, CHAOS_ID), null);
});

test("hub rates are derived from the exchange itself, not borrowed", () => {
  const index = buildChaosIndex([CHAOS_DIVINE], { league: LEAGUE, minVolume: 20 });

  assert.equal(index.chaosPerDivine?.toFixed(4), Math.sqrt(20).toFixed(4));
  assert.equal(index.entries.get(DIVINE_ID)?.chaosValue.toFixed(4), Math.sqrt(20).toFixed(4));
  assert.equal(index.entries.get(CHAOS_ID)?.chaosValue, 1);
});

test("an item quoted only against exalted is still priced in chaos", () => {
  // Exalted is the feed's busiest hub, so this hop is the common case, not an edge case.
  const exaltedChaos = market([EXALTED_ID, CHAOS_ID], [50, 1], [50, 1], [5000, 100]);
  const thing = "Metadata/Items/Currency/CurrencyThing";
  const thingExalted = market([thing, EXALTED_ID], [1, 10], [1, 10], [500, 5000]);

  const index = buildChaosIndex([CHAOS_DIVINE, exaltedChaos, thingExalted], { league: LEAGUE, minVolume: 20 });

  // 1 exalted = 1/50 chaos; 1 thing = 10 exalted = 0.2 chaos.
  assert.equal(index.chaosPerExalted?.toFixed(4), (1 / 50).toFixed(4));
  assert.equal(index.entries.get(thing)?.chaosValue.toFixed(4), (0.2).toFixed(4));
});

test("chaos-per-exalted bridges through divine when no exalted/chaos market exists", () => {
  const exaltedDivine = market([EXALTED_ID, DIVINE_ID], [400, 1], [400, 1], [40000, 100]);
  const index = buildChaosIndex([CHAOS_DIVINE, exaltedDivine], { league: LEAGUE, minVolume: 20 });

  // 1 exalted = 1/400 divine, and 1 divine = sqrt(20) chaos.
  assert.equal(index.chaosPerExalted?.toFixed(6), (Math.sqrt(20) / 400).toFixed(6));
});

test("markets below the volume floor contribute nothing", () => {
  const thing = "Metadata/Items/Currency/CurrencyThing";
  const thin = market([thing, DIVINE_ID], [1, 5], [1, 5], [3, 15]);

  const index = buildChaosIndex([CHAOS_DIVINE, thin], { league: LEAGUE, minVolume: 20 });

  assert.equal(index.entries.has(thing), false);
});

test("repeat appearances across hours combine weighted by volume", () => {
  const thing = "Metadata/Items/Currency/CurrencyThing";
  // 1 thing = 1 divine on heavy volume, 1 thing = 3 divine on light volume. The blend must sit
  // near the heavily-traded number, not midway between the two.
  const heavy = market([thing, DIVINE_ID], [1, 1], [1, 1], [9000, 9000]);
  const light = market([thing, DIVINE_ID], [1, 3], [1, 3], [1000, 1000]);

  const index = buildChaosIndex([CHAOS_DIVINE, heavy, light], { league: LEAGUE, minVolume: 20 });
  const inDivine = index.entries.get(thing)!.chaosValue / index.chaosPerDivine!;

  assert.equal(inDivine.toFixed(2), (1.2).toFixed(2));
  assert.equal(index.entries.get(thing)!.volume, 10000);
});

test("markets from other leagues are filtered out", () => {
  const thing = "Metadata/Items/Currency/CurrencyThing";
  const elsewhere = market([thing, DIVINE_ID], [1, 5], [1, 5], [900, 900], "Standard");

  const index = buildChaosIndex([CHAOS_DIVINE, elsewhere], { league: LEAGUE, minVolume: 20 });

  assert.equal(index.entries.has(thing), false);
});

test("the seed hour skips the current hour, which the feed never publishes", () => {
  const noonUtc = Date.UTC(2026, 7, 6, 12, 34, 56);
  assert.equal(seedHour(noonUtc, 2), Date.UTC(2026, 7, 6, 10, 0, 0) / 1000);
});

test("pagination walks forward and stops when the feed echoes the requested id", async () => {
  const requested: number[] = [];
  const client = new CurrencyExchangeClient(makeSettings(), async (url) => {
    const hour = Number(url.split("/").pop());
    requested.push(hour);
    // Two hours of data, then the stream signals its end by echoing the id back.
    const next = requested.length >= 3 ? hour : hour + 3600;
    return {
      ok: true,
      status: 200,
      json: async () => ({ next_change_id: next, markets: [CHAOS_DIVINE] })
    } as Response;
  });

  await client.refresh();

  assert.equal(requested.length, 3);
  assert.equal(requested[1] - requested[0], 3600);
  assert.equal(client.getDerivedRates().chaosPerDivine?.toFixed(4), Math.sqrt(20).toFixed(4));
});

test("pagination is capped so a stalled stream can't spin forever", async () => {
  let calls = 0;
  const client = new CurrencyExchangeClient(makeSettings({ maxPagesPerRefresh: 4 }), async (url) => {
    calls++;
    const hour = Number(url.split("/").pop());
    return {
      ok: true,
      status: 200,
      json: async () => ({ next_change_id: hour + 3600, markets: [CHAOS_DIVINE] })
    } as Response;
  });

  await client.refresh();

  assert.equal(calls, 4);
});

test("a refresh that returns nothing usable leaves the previous prices alone", async () => {
  let payload: unknown = { next_change_id: 0, markets: [CHAOS_DIVINE] };
  const client = new CurrencyExchangeClient(makeSettings({ maxPagesPerRefresh: 1 }), async () => {
    return { ok: true, status: 200, json: async () => payload } as Response;
  });

  await client.refresh();
  const good = client.getDerivedRates().chaosPerDivine;
  assert.ok(good);

  payload = { next_change_id: 0, markets: [] };
  await client.refresh();

  assert.equal(client.getDerivedRates().chaosPerDivine, good, "a bad refresh must not wipe good data");
});

test("an all-other-league response is reported rather than silently emptying the index", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    const client = new CurrencyExchangeClient(makeSettings({ maxPagesPerRefresh: 1 }), async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        next_change_id: 0,
        markets: [market([CHAOS_ID, DIVINE_ID], [4, 1], [5, 1], [43546, 10883], "Some Other League")]
      })
    }) as Response);

    await client.refresh();
    assert.match(warnings.join("\n"), /none in league/);
  } finally {
    console.warn = original;
  }
});

test("an unmapped item name returns null instead of throwing", () => {
  const client = new CurrencyExchangeClient(makeSettings());
  assert.equal(client.getChaosValueForItem(item("Some Unlisted Orb")), null);
  assert.equal(client.describeLookup(item("Some Unlisted Orb")).metadataId, null);
});

/**
 * `getChaosValueForItem` delegates to `getChaosValue`, the name-only door this keeps symmetrical
 * with `PoeNinjaClient`. The two must never drift apart, or a currency would price differently
 * depending on which one it came in through.
 */
test("the name-only lookup and the parsed-item lookup agree", async () => {
  const client = new CurrencyExchangeClient(makeSettings(), async (url) => {
    const hour = Number(url.split("/").pop());
    return {
      ok: true,
      status: 200,
      json: async () => ({ next_change_id: hour, markets: [CHAOS_DIVINE] })
    } as Response;
  });
  await client.refresh();

  const viaItem = client.getChaosValueForItem(item("Divine Orb"));
  assert.equal(typeof viaItem, "number", "the fixture prices divine, so this is a real lookup");
  assert.equal(client.getChaosValue("Divine Orb"), viaItem);
  // Case and whitespace are normalised in one place, so both doors inherit it.
  assert.equal(client.getChaosValue("  divine orb  "), viaItem);
  assert.equal(client.getChaosValue("Some Unlisted Orb"), null);
});

test("the three hub currencies are mapped, since every other price is derived through them", () => {
  assert.equal(metadataIdForName("Chaos Orb"), CHAOS_ID);
  assert.equal(metadataIdForName("Divine Orb"), DIVINE_ID);
  assert.equal(metadataIdForName("Exalted Orb"), EXALTED_ID);
  // Case and surrounding whitespace come from clipboard text, so they must not matter.
  assert.equal(metadataIdForName("  divine orb  "), DIVINE_ID);
});
