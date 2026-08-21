import assert from "node:assert/strict";
import { test } from "node:test";
import { PriceResolver } from "../pricing/price-resolver";
import { PoeNinjaClient } from "../pricing/poeninja-client";
import type { Trade2Client } from "../pricing/trade2-client";
import type { CurrencyExchangeClient } from "../pricing/currency-exchange-client";
import type { Settings } from "../shared/settings";
import { parseItemText } from "../parser/item-text-parser";
import type { ParsedItem, PricedItem } from "../shared/types";

const CORE = { rates: { exalted: 374.7, chaos: 7.86 }, primary: "divine", secondary: "chaos" };

const FIXTURES: Record<string, unknown> = {
  Currency: { core: CORE, lines: [{ id: "alch", primaryValue: 0.002 }] },
  UncutGems: { core: CORE, lines: [{ id: "uncut-support-gem-5", primaryValue: 0.01645 }] }
};

function makeClient(exchangeTypes: string[]): PoeNinjaClient {
  const settings = {
    league: "Runes of Aldur",
    poeNinja: {
      baseUrl: "https://poe.ninja/poe2/api/economy",
      refreshIntervalMs: 900000,
      itemOverviewTypes: [],
      exchangeOverviewTypes: exchangeTypes
    }
  } as unknown as Settings;

  const fetchStub = (async (input: URL | RequestInfo) => {
    const type = new URL(String(input)).searchParams.get("type") ?? "";
    const body = FIXTURES[type];
    if (!body) return { ok: false, status: 404, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  return new PoeNinjaClient(settings, fetchStub);
}

/** Stands in for trade2 being switched off — the client itself words that refusal. */
const DISABLED_TRADE2 = {
  isAvailable: false,
  estimateRareValue: async () => ({
    chaosValue: null,
    reason: "trade2 lookups are switched off (trade2.enabled is false in settings)",
    listings: 0,
    matches: 0,
    matchedMods: 0,
    totalMods: 0,
    rungs: [],
    defences: [],
    defencesDropped: false
  })
} as unknown as Trade2Client;

function makeTrade2(estimate: {
  chaosValue: number | null;
  reason: string | null;
  listings: number;
  /** The median of the same sample. Defaults to the price, i.e. a sample with no spread. */
  medianChaosValue?: number | null;
  /** Whether the rate limit is why there is no price. Defaults to false, the ordinary miss. */
  rateLimited?: boolean;
}): Trade2Client {
  return {
    isAvailable: true,
    // `matches` only differs from `listings` when the search out-ran the sample; these cases don't,
    // and they all price off a four-mod item whose strictest rung hit.
    estimateRareValue: async () => ({
      ...estimate,
      rateLimited: estimate.rateLimited ?? false,
      medianChaosValue: estimate.medianChaosValue ?? estimate.chaosValue,
      matches: estimate.listings,
      matchedMods: 4,
      totalMods: 4,
      rungs: [{ required: 4, total: estimate.listings }],
      defences: [],
      defencesDropped: false
    })
  } as unknown as Trade2Client;
}

/** An exchange that knows nothing, so these cases exercise poe.ninja's path exactly as before. */
const INERT_EXCHANGE = {
  getChaosValueForItem: () => null,
  describeLookup: () => ({ metadataId: null, entriesLoaded: 0 })
} as unknown as CurrencyExchangeClient;

function makeExchange(chaosValue: number | null, metadataId = "Metadata/Items/Currency/Test"): CurrencyExchangeClient {
  return {
    getChaosValueForItem: () => chaosValue,
    describeLookup: () => ({ metadataId, entriesLoaded: 42 })
  } as unknown as CurrencyExchangeClient;
}

const ONE_HOUR = 3600000;

function makeResolver(
  poeNinja: PoeNinjaClient,
  exchange: CurrencyExchangeClient = INERT_EXCHANGE,
  staleAfterMs = ONE_HOUR,
  trade2: Trade2Client = DISABLED_TRADE2
): PriceResolver {
  return new PriceResolver(poeNinja, exchange, trade2, staleAfterMs);
}

function parse(rawText: string): ParsedItem {
  const item = parseItemText(rawText);
  assert.ok(item);
  return item!;
}

const UNCUT_SUPPORT_GEM = parse(
  "Item Class: Skill Gems\nRarity: Currency\nUncut Support Gem (Level 5)\n--------\n" +
    "Right click to view all Support Gems you can create."
);

const RARE = parse(
  "Item Class: Amulets\nRarity: Rare\nApocalypse Core\nJade Amulet\n--------\nItem Level: 78\n" +
    "--------\n+35 to Dexterity"
);

const UNKNOWN_CURRENCY = parse(
  "Item Class: Stackable Currency\nRarity: Currency\nSome Unlisted Orb\n--------\nStack Size: 1/10"
);

/** Captures console.log so the reason text can be asserted the way a user would read it. */
async function resolveCapturingLog(
  resolver: PriceResolver,
  item: ParsedItem
): Promise<{ lines: string[]; chaosValue: number | null; item: Omit<PricedItem, "id"> }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    const result = await resolver.resolve(item);
    // The whole stored item, not just its price: what the resolver persists alongside a null value is
    // as much a part of its contract as the number is.
    return { lines, chaosValue: result.chaosValue, item: result };
  } finally {
    console.log = original;
  }
}

test("a cold cache is reported as such, not blamed on the item", async () => {
  const poeNinja = makeClient(["Currency"]);
  // Deliberately not refreshed — this is the startup race, where a capture arrives before the
  // first poe.ninja response.
  const { lines, chaosValue } = await resolveCapturingLog(
    makeResolver(poeNinja),
    UNCUT_SUPPORT_GEM
  );

  assert.equal(chaosValue, null);
  assert.match(lines.join("\n"), /hasn't loaded yet/);
});

test("an unpriced rare repeats trade2's own reason rather than inventing one", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const budgetSpent = makeTrade2({
    chaosValue: null,
    reason: "trade2 search budget spent (10 per 5min; GGG rate-limits by IP) — retry in ~90s",
    listings: 0
  });
  const { lines } = await resolveCapturingLog(
    makeResolver(poeNinja, INERT_EXCHANGE, ONE_HOUR, budgetSpent),
    RARE
  );
  const log = lines.join("\n");

  assert.match(log, /search budget spent/);
  assert.match(log, /manual price/);
  // It must not claim a poe.ninja lookup failure — there was nothing to look a rare up in.
  assert.doesNotMatch(log, /not found in poe\.ninja data/);
});

test("a rate-limited rare records why, so the row can say it wasn't looked up", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const budgetSpent = makeTrade2({
    chaosValue: null,
    reason: "trade2 search budget spent (10 per 5min; GGG rate-limits by IP) — retry in ~90s",
    listings: 0,
    rateLimited: true
  });
  const { item } = await resolveCapturingLog(
    makeResolver(poeNinja, INERT_EXCHANGE, ONE_HOUR, budgetSpent),
    RARE
  );

  assert.equal(item.priceSource, "unpriced");
  // The reason only ever reached the log before this. The row shows "unpriced" for an item the
  // market genuinely has nothing for and for one nobody has looked at yet, and those need different
  // things from the user — one of them resolves by waiting.
  assert.equal(item.unpricedReason, "rateLimited");
});

test("an ordinary unpriced rare records no reason, since waiting won't help", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const noListings = makeTrade2({
    chaosValue: null,
    reason: "no listings match this Sapphire Ring on 4 of its mods",
    listings: 0
  });
  const { item } = await resolveCapturingLog(
    makeResolver(poeNinja, INERT_EXCHANGE, ONE_HOUR, noListings),
    RARE
  );

  assert.equal(item.priceSource, "unpriced");
  // A search that went out and found an empty market is a fact about the item, not a state that
  // expires — badging it "rate limited" would send the user to press Reprice forever.
  assert.equal(item.unpricedReason, undefined);
});

test("a rare is priced from trade2 when poe.ninja and the exchange both miss", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const trade2 = makeTrade2({ chaosValue: 42, reason: null, listings: 7, medianChaosValue: 60 });
  const { lines, chaosValue } = await resolveCapturingLog(
    makeResolver(poeNinja, INERT_EXCHANGE, ONE_HOUR, trade2),
    RARE
  );

  // The stored value is the floor. The median is reported beside it rather than instead of it, so
  // the log says how thin that floor was without changing what was persisted.
  assert.equal(chaosValue, 42);
  assert.match(
    lines.join("\n"),
    /priced via trade2: 42 chaos \(cheapest of 7 sampled from 7 listings, median 60; matching all 4 mods\)/
  );
});

test("with trade2 switched off, the rare's reason says so instead of blaming the item", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const { lines } = await resolveCapturingLog(makeResolver(poeNinja), RARE);

  assert.match(lines.join("\n"), /switched off/);
});

test("a magic item explains the affixed-header problem rather than pointing at trade2", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const magic = parse(
    "Item Class: Rings\nRarity: Magic\nSharp Sapphire Ring of the Polar Bear\n--------\nItem Level: 60"
  );
  const { lines } = await resolveCapturingLog(makeResolver(poeNinja), magic);
  const log = lines.join("\n");

  assert.match(log, /glues the affixes onto the base type/);
  assert.match(log, /manual price/);
});

test("a genuine lookup miss reports the ids tried, so a bad mapping is visible", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const { lines } = await resolveCapturingLog(
    makeResolver(poeNinja),
    UNKNOWN_CURRENCY
  );
  const log = lines.join("\n");

  assert.match(log, /not found in poe\.ninja data/);
  assert.match(log, /some-unlisted-orb/, "the slug actually probed must appear in the log");
  assert.match(log, /entries loaded/);
});

test("the reported keys are the ones the lookup really used", async () => {
  const poeNinja = makeClient(["UncutGems"]);
  await poeNinja.refresh();

  // The id that resolves this item must be among the keys the diagnostic reports; if these two
  // ever drift, the log would send someone hunting for the wrong bug.
  const { keysTried } = poeNinja.describeLookup(UNCUT_SUPPORT_GEM);
  assert.ok(keysTried.includes("uncut-support-gem-5"), keysTried.join(", "));
  assert.equal(poeNinja.getChaosValueForItem(UNCUT_SUPPORT_GEM), 0.01645 * 7.86);
});

test("a successful price is logged in readable digits, not raw float noise", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const alch = parse("Item Class: Stackable Currency\nRarity: Currency\nOrb of Alchemy\n--------\nStack Size: 1/10");
  const { lines } = await resolveCapturingLog(makeResolver(poeNinja), alch);

  // 0.002 * 7.86 = 0.015720000000000002 in float; the log should not show that.
  assert.match(lines.join("\n"), /priced via poe\.ninja: 0\.02 chaos/);
});

test("the exchange fills in an item poe.ninja doesn't list", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const result = await makeResolver(poeNinja, makeExchange(3.5)).resolve(UNKNOWN_CURRENCY);

  assert.equal(result.chaosValue, 3.5);
  assert.equal(result.priceSource, "currencyExchange");
});

test("poe.ninja stays primary while its data is fresh, even when the exchange has a price", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const alch = parse("Item Class: Stackable Currency\nRarity: Currency\nOrb of Alchemy\n--------\nStack Size: 1/10");
  const result = await makeResolver(poeNinja, makeExchange(999)).resolve(alch);

  assert.equal(result.priceSource, "poeninja");
  assert.equal(result.chaosValue, 0.002 * 7.86);
});

test("stale poe.ninja data defers to the exchange", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const alch = parse("Item Class: Stackable Currency\nRarity: Currency\nOrb of Alchemy\n--------\nStack Size: 1/10");
  // staleAfterMs of 0 makes any refresh, however recent, count as stale.
  const result = await makeResolver(poeNinja, makeExchange(12), 0).resolve(alch);

  assert.equal(result.priceSource, "currencyExchange");
  assert.equal(result.chaosValue, 12);
});

test("stale poe.ninja still beats nothing when the exchange has no price either", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const alch = parse("Item Class: Stackable Currency\nRarity: Currency\nOrb of Alchemy\n--------\nStack Size: 1/10");
  const { lines, chaosValue } = await resolveCapturingLog(
    makeResolver(poeNinja, INERT_EXCHANGE, 0),
    alch
  );

  assert.equal(chaosValue, 0.002 * 7.86);
  assert.match(lines.join("\n"), /stale, no exchange fallback/);
});

test("an unpriced item says which of the two ways the exchange came up short", async () => {
  const poeNinja = makeClient(["Currency"]);
  await poeNinja.refresh();

  const unmapped = await resolveCapturingLog(makeResolver(poeNinja), UNKNOWN_CURRENCY);
  assert.match(unmapped.lines.join("\n"), /no entry in exchange-metadata-ids\.ts/);

  const mappedButUntraded = await resolveCapturingLog(
    makeResolver(poeNinja, makeExchange(null, "Metadata/Items/Currency/CurrencyThing")),
    UNKNOWN_CURRENCY
  );
  assert.match(mappedButUntraded.lines.join("\n"), /not traded on the currency exchange/);
  assert.match(mappedButUntraded.lines.join("\n"), /CurrencyThing/);
});

const WHITE_BASE = parse(
  "Item Class: Foci\nRarity: Normal\nSacred Focus\n--------\nEnergy Shield: 152\n--------\n" +
    "Item Level: 82"
);

test("a white base reaches trade2, which is the only source that can price one", async () => {
  // The reported bug: the resolver gated on Rare alone, so a base item tried poe.ninja and the
  // currency exchange — neither of which publishes base items — and stored unpriced without ever
  // asking the one API that lists them. Whether it is *worth* asking is the client's call now.
  let asked = false;
  const trade2 = {
    isAvailable: true,
    estimateRareValue: async () => {
      asked = true;
      return {
        chaosValue: 12,
        medianChaosValue: 12,
        reason: null,
        listings: 3,
        matches: 3,
        matchedMods: 0,
        totalMods: 0,
        rungs: [],
        defences: [],
        defencesDropped: false,
        pseudoStats: [],
        pseudoDropped: false,
        mapDropped: false,
        statCoverage: [],
        coverageSample: 3,
        autoDroppedMods: [],
        searchedMods: []
      };
    }
  } as unknown as Trade2Client;

  const resolver = makeResolver(makeClient([]), INERT_EXCHANGE, ONE_HOUR, trade2);
  const priced = await resolver.resolve(WHITE_BASE);

  assert.ok(asked, "a Normal-rarity base must be offered to trade2");
  assert.equal(priced.chaosValue, 12);
  assert.equal(priced.priceSource, "trade2");
});

test("a refused base item says why, instead of reading as no data anywhere", async () => {
  const trade2 = {
    isAvailable: true,
    estimateRareValue: async () => ({
      chaosValue: null,
      medianChaosValue: null,
      reason: "item level 65 is below trade2.baseItemMinLevel (81), so no search was made",
      listings: 0,
      matches: 0,
      matchedMods: 0,
      totalMods: 0,
      rungs: [],
      defences: [],
      defencesDropped: false
    })
  } as unknown as Trade2Client;

  const resolver = makeResolver(makeClient([]), INERT_EXCHANGE, ONE_HOUR, trade2);
  const priced = await resolver.resolve(WHITE_BASE);

  assert.equal(priced.chaosValue, null);
  assert.equal(priced.priceSource, "unpriced");
});
