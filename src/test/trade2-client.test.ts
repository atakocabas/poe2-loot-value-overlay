import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Trade2Client,
  priceSample,
  modLadder,
  requiredModMatches,
  toModFilterMap
} from "../pricing/trade2-client";
import type { GggFetch } from "../pricing/ggg-fetch";
import { parseItemText } from "../parser/item-text-parser";
import type { ModFilter, ParsedItem } from "../shared/types";
import type { Settings } from "../shared/settings";

const STATS = {
  result: [
    {
      id: "explicit",
      entries: [
        { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
        { id: "explicit.stat_4220027924", text: "#% to Cold Resistance", type: "explicit" }
      ]
    },
    { id: "implicit", entries: [] }
  ]
};

interface Call {
  url: string;
  init: RequestInit;
}

interface StubOptions {
  searchIds?: string[];
  /** Matching listings the search reports, which `searchIds` is only the first 100 of. */
  searchTotal?: number;
  /** Ids per successive search call, for walking the mod ladder: `[[], [], ["id-a"]]`. */
  searchIdsSequence?: string[][];
  searchStatus?: number;
  fetchStatus?: number;
  listings?: Array<{ amount: number; currency: string } | null>;
  retryAfter?: string;
  stats?: unknown;
  /** Per-attempt search statuses, so a transient failure can be followed by a success. */
  searchStatusSequence?: number[];
  throwOnSearch?: number;
  /**
   * `item.extended.hashes` per fetched listing — the stat ids that listing carries, which is the only
   * thing in GGG's response saying *which* of a `count` search's filters it satisfied.
   */
  hashesSequence?: Array<Record<string, Array<[string, number[]]>>>;
}

/** Records every request so the tests can assert on URLs, headers and the search body GGG sees. */
function stubFetch(options: StubOptions = {}): { fetch: GggFetch; calls: Call[] } {
  const calls: Call[] = [];
  const {
    searchIds = ["id-a", "id-b", "id-c"],
    searchStatus = 200,
    fetchStatus = 200,
    listings = [
      { amount: 1, currency: "exalted" },
      { amount: 5, currency: "exalted" },
      { amount: 10, currency: "exalted" }
    ]
  } = options;

  const fetch: GggFetch = async (url, init = {}) => {
    calls.push({ url, init });

    if (url.includes("/data/stats")) {
      return new Response(JSON.stringify(options.stats ?? STATS), { status: 200 });
    }
    if (url.includes("/search/")) {
      const attempt = calls.filter((call) => call.url.includes("/search/")).length - 1;
      if (options.throwOnSearch !== undefined && attempt < options.throwOnSearch) {
        throw new Error("socket hang up");
      }
      const status = options.searchStatusSequence
        ? options.searchStatusSequence[Math.min(attempt, options.searchStatusSequence.length - 1)]
        : searchStatus;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { code: 2, message: "Invalid query" } }), {
          status,
          headers: options.retryAfter ? { "retry-after": options.retryAfter } : {}
        });
      }
      const result = options.searchIdsSequence
        ? (options.searchIdsSequence[attempt] ?? [])
        : searchIds;
      // GGG caps `result` at 100 ids however many listings matched, so `total` is its own number.
      return new Response(
        JSON.stringify({ id: "query-123", result, total: options.searchTotal ?? result.length }),
        { status: 200 }
      );
    }
    if (fetchStatus !== 200) {
      return new Response(JSON.stringify({ error: { code: 3, message: "Nope" } }), { status: fetchStatus });
    }
    return new Response(
      JSON.stringify({
        result: listings.map((price, index) => ({
          listing: { price },
          ...(options.hashesSequence
            ? { item: { extended: { hashes: options.hashesSequence[index] ?? {} } } }
            : {})
        }))
      }),
      { status: 200 }
    );
  };

  return { fetch, calls };
}

function makeSettings(overrides: Partial<Settings["trade2"]> = {}): Settings {
  return {
    league: "Runes of Aldur",
    trade2: {
      enabled: true,
      contactEmail: "someone@example.com",
      maxSearchesPerWindow: 10,
      windowMs: 300000,
      // 0 so the tests never actually sleep; the spacing itself is covered in trade-budget.test.ts.
      minSearchIntervalMs: 0,
      maxListings: 5,
      listingStatus: "online",
      maxModLadderSearches: 3,
      minListingsForMatch: 3,
      minModMatchRatio: 0.5,
      useDefenceFilters: true,
      defenceMinRatio: 0.9,
      usePseudoFilters: true,
      pseudoMinRatio: 0.9,
      useMapFilters: true,
      mapMinRatio: 0.9,
      maxTransientRetries: 1,
      ...overrides
    }
  } as unknown as Settings;
}

/**
 * Five stats that stay five filters. Deliberately *not* resistances or attributes: those fold into a
 * pseudo aggregate now, which is the right behaviour but would leave the ladder tests below with two
 * filters and nothing left to ladder through. Folding has its own tests further down.
 */
const STATS_5 = {
  result: [
    {
      id: "explicit",
      entries: [
        { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
        { id: "explicit.stat_4220027924", text: "#% increased Attack Speed", type: "explicit" },
        { id: "explicit.stat_3372524247", text: "#% increased Cast Speed", type: "explicit" },
        { id: "explicit.stat_1671376347", text: "# to Accuracy Rating", type: "explicit" },
        { id: "explicit.stat_3917489142", text: "#% increased Rarity of Items found", type: "explicit" }
      ]
    },
    { id: "implicit", entries: [] }
  ]
};

/** A five-mod rare — the ordinary case, and the one an all-mods search finds nothing for. */
const FIVE_MOD_RARE = parse(
  "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n--------\n" +
    "+82 to maximum Life\n12% increased Attack Speed\n9% increased Cast Speed\n" +
    "+150 to Accuracy Rating\n15% increased Rarity of Items found"
);

const RARE = parse(
  "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
    "--------\n+80 to maximum Life\n+45% to Cold Resistance"
);

function parse(rawText: string): ParsedItem {
  const item = parseItemText(rawText);
  assert.ok(item);
  return item!;
}

/** Trade listings quote in exalted/divine; chaos is only ever the app's internal storage unit. */
const toChaos = (amount: number, currency: string): number | null =>
  currency === "exalted" ? amount * 2 : currency === "divine" ? amount * 100 : null;

const searchCall = (calls: Call[]): Call => calls.find((call) => call.url.includes("/search/"))!;
/** The ladder's last rung — the floor, and the query this sent as its only one before the ladder. */
const lastSearchCall = (calls: Call[]): Call =>
  calls.filter((call) => call.url.includes("/search/")).at(-1)!;
/** Enough empty results to walk any ladder in these tests to its end. */
const NO_LISTINGS: string[][] = [[], [], [], []];
const fetchCall = (calls: Call[]): Call | undefined =>
  calls.find((call) => call.url.includes("/fetch/"));

test("prices a rare from the median of the returned listings", async () => {
  const { fetch } = stubFetch();
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  // 1, 5, 10 exalted -> 2, 10, 20 chaos; median is 10.
  assert.equal(estimate.chaosValue, 10);
  assert.equal(estimate.reason, null);
  assert.equal(estimate.listings, 3);
  assert.equal(estimate.matches, 3);
});

test("reports the full match count alongside the sample the median came from", async () => {
  const { fetch } = stubFetch({
    searchIds: Array.from({ length: 100 }, (_, index) => `id-${index}`),
    searchTotal: 236
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.listings, 3);
  assert.equal(estimate.matches, 236);
});

test("sends no Authorization header and targets the poe2 realm", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  // The regression guard for this whole feature: a Bearer header against an endpoint that takes no
  // token is what made this client permanently inert, and it fails silently rather than erroring.
  for (const call of calls) {
    const headers = (call.init.headers ?? {}) as Record<string, string>;
    assert.equal(headers.authorization, undefined, `${call.url} sent an Authorization header`);
  }
  assert.match(searchCall(calls).url, /\/api\/trade2\/search\/poe2\/Runes%20of%20Aldur$/);
});

test("turns the item's mods into stat filters, honouring the ignore list", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(["+45% to Cold Resistance"]),
    toChaos
  );

  const body = JSON.parse(String(searchCall(calls).init.body));
  assert.equal(body.query.type, "Sapphire Ring");
  assert.deepEqual(body.query.stats, [
    { type: "count", value: { min: 1 }, filters: [{ id: "explicit.stat_3299347043", value: { min: 80 } }] }
  ]);
  assert.equal(body.sort.price, "asc");
});

test("a five-mod rare falls back to requiring only three, which is what makes it findable at all", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_5, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(FIVE_MOD_RARE, new Set(), toChaos);

  // The ladder's last rung, which is the only query this sent before the strict rungs existed.
  const [stats] = JSON.parse(String(lastSearchCall(calls).init.body)).query.stats;

  // Measured live: this exact shape returns 0 listings as `{type:"and"}` and 44 as `count` min 3.
  // A regression to "and" would leave every ordinary rare unpriced with no error to show for it.
  assert.equal(stats.type, "count");
  assert.equal(stats.value.min, 3);
  assert.equal(stats.filters.length, 5, "all five mods are still offered as candidates to match");
});

test("the required-match count is reported so the log explains a miss", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_5, searchIds: [] });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.match(estimate.reason!, /3 or more of its 5 mods/);
  assert.equal(searchCall(calls).url.includes("/search/"), true);
});

test("minModMatchRatio sets how far the ladder is allowed to descend", async () => {
  const strict = stubFetch({ stats: STATS_5, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings({ minModMatchRatio: 1 }), strict.fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );
  // A ratio of 1 puts the floor at the strict rung, so there is nothing to descend to.
  assert.equal(strict.calls.filter((call) => call.url.includes("/search/")).length, 1);
  assert.equal(JSON.parse(String(lastSearchCall(strict.calls).init.body)).query.stats[0].value.min, 5);

  const loose = stubFetch({ stats: STATS_5, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings({ minModMatchRatio: 0.2 }), loose.fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );
  assert.equal(JSON.parse(String(lastSearchCall(loose.calls).init.body)).query.stats[0].value.min, 2);
});

test("a stat GGG indexes without a number is asked for by presence, never as min: null", async () => {
  const stats = {
    result: [
      {
        id: "explicit",
        entries: [
          { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
          // 1418 of the live reference's 3097 explicit templates look like this — no placeholder.
          { id: "explicit.stat_1penalty", text: "Cannot be Frozen", type: "explicit" }
        ]
      },
      { id: "implicit", entries: [] }
    ]
  };
  const item = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      "--------\n+80 to maximum Life\nCannot be Frozen"
  );
  const { fetch, calls } = stubFetch({ stats });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(item, new Set(), toChaos);

  const [group] = JSON.parse(String(searchCall(calls).init.body)).query.stats;
  // `Number(undefined)` is NaN and JSON.stringify writes NaN as null; GGG matches nothing against
  // `{"min": null}`, so one such mod used to zero out the whole search silently.
  assert.deepEqual(group.filters, [
    { id: "explicit.stat_3299347043", value: { min: 80 } },
    { id: "explicit.stat_1penalty" }
  ]);
});

test("listingStatus decides whether offline sellers count, and the wording follows it", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);
  assert.equal(JSON.parse(String(searchCall(calls).init.body)).query.status.option, "online");

  // Measured: a four-mod Emerald had 0 online listings carrying all its mods and 5 counting offline
  // ones, which is the usual reason this disagrees with what the trade site shows.
  const any = stubFetch({ searchIds: [] });
  const estimate = await new Trade2Client(
    makeSettings({ listingStatus: "any" }),
    any.fetch
  ).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(JSON.parse(String(searchCall(any.calls).init.body)).query.status.option, "any");
  // "no online listings" would be a lie about a search that counted offline ones too.
  assert.doesNotMatch(estimate.reason!, /online/);
});

test("an uncorrupted item doesn't demand uncorrupted listings", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  // Measured: on a real thin base this filter alone took the match count from 1 to 0. Corrupted
  // listings are close enough comparables to be worth keeping when the market is this shallow.
  assert.equal(JSON.parse(String(searchCall(calls).init.body)).query.filters, undefined);
});

test("a corrupted item is priced only against corrupted listings", async () => {
  const corrupted = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      "--------\n+80 to maximum Life\n--------\nCorrupted"
  );
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(corrupted, new Set(), toChaos);

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;
  // The asymmetry is the point: an uncorrupted item can still be modified and is worth more, so
  // pricing a corrupted drop off uncorrupted listings would overstate it.
  assert.equal(filters.misc_filters.filters.corrupted.option, "true");
});

test("two affixes granting the same stat are summed into one filter", async () => {
  const stats = {
    result: [
      {
        id: "explicit",
        entries: [{ id: "explicit.stat_EVASION", text: "# to Evasion Rating", type: "explicit" }]
      },
      { id: "implicit", entries: [] }
    ]
  };
  // Two prefixes both granting Evasion Rating, exactly as on a real body armour.
  const twoPrefixes = parse(
    "Item Class: Body Armours\nRarity: Rare\nGhoul Hide\nFalconer's Jacket\n--------\nItem Level: 81\n" +
      "--------\n+144 to Evasion Rating\n+49 to Evasion Rating"
  );
  const { fetch, calls } = stubFetch({ stats });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(twoPrefixes, new Set(), toChaos);

  const [stat] = JSON.parse(String(searchCall(calls).init.body)).query.stats;

  // GGG indexes the total, so asking for "144 and separately 49" matches nothing.
  assert.deepEqual(stat.filters, [{ id: "explicit.stat_EVASION", value: { min: 193 } }]);
  assert.equal(stat.value.min, 1, "one distinct stat, so one required match");
});

// ---------------------------------------------------------------------------
// Per-mod bounds from the row editor
// ---------------------------------------------------------------------------

/** The filters of the first (strictest) search, which is where the bounds land. */
function statFiltersOf(calls: Call[]): Array<{ id: string; value?: { min?: number; max?: number } }> {
  return JSON.parse(String(searchCall(calls).init.body)).query.stats[0].filters;
}

test("a bound set in the row editor replaces the roll the item happens to have", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos,
    // Widening the life requirement is the whole point: pinned at its own +80, a good item matches
    // only items strictly better than itself.
    toModFilterMap([{ text: "+80 to maximum Life", min: 60, max: null }])
  );

  assert.deepEqual(statFiltersOf(calls), [
    { id: "explicit.stat_3299347043", value: { min: 60 } },
    { id: "explicit.stat_4220027924", value: { min: 45 } }
  ]);
});

test("a mod with no bound left on it is searched by presence, not by min: null", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos,
    toModFilterMap([{ text: "+80 to maximum Life", min: null, max: null }])
  );

  // Clearing the box is a real request — "any amount of life" — and the only correct shape for it is
  // a bare id. `{"min": null}` would take the entire search to zero results instead.
  assert.deepEqual(statFiltersOf(calls)[0], { id: "explicit.stat_3299347043" });
});

test("a ceiling is sent alongside the floor", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos,
    toModFilterMap([{ text: "+80 to maximum Life", min: 70, max: 90 }])
  );

  assert.deepEqual(statFiltersOf(calls)[0], {
    id: "explicit.stat_3299347043",
    value: { min: 70, max: 90 }
  });
});

test("bounds on two affixes feeding one stat are summed like the rolls they replace", async () => {
  const stats = {
    result: [
      {
        id: "explicit",
        entries: [{ id: "explicit.stat_EVASION", text: "# to Evasion Rating", type: "explicit" }]
      },
      { id: "implicit", entries: [] }
    ]
  };
  const twoPrefixes = parse(
    "Item Class: Body Armours\nRarity: Rare\nGhoul Hide\nFalconer's Jacket\n--------\nItem Level: 81\n" +
      "--------\n+144 to Evasion Rating\n+49 to Evasion Rating"
  );
  const { fetch, calls } = stubFetch({ stats });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    twoPrefixes,
    new Set(),
    toChaos,
    toModFilterMap([
      { text: "+144 to Evasion Rating", min: 100, max: 200 },
      { text: "+49 to Evasion Rating", min: 40, max: 60 }
    ])
  );

  // GGG indexes the total, so the bounds have to be added up the same way the rolls are.
  assert.deepEqual(statFiltersOf(calls), [
    { id: "explicit.stat_EVASION", value: { min: 140, max: 260 } }
  ]);
});

test("a ceiling on only some of the affixes feeding a stat is dropped, not half-summed", async () => {
  const stats = {
    result: [
      {
        id: "explicit",
        entries: [{ id: "explicit.stat_EVASION", text: "# to Evasion Rating", type: "explicit" }]
      },
      { id: "implicit", entries: [] }
    ]
  };
  const twoPrefixes = parse(
    "Item Class: Body Armours\nRarity: Rare\nGhoul Hide\nFalconer's Jacket\n--------\nItem Level: 81\n" +
      "--------\n+144 to Evasion Rating\n+49 to Evasion Rating"
  );
  const { fetch, calls } = stubFetch({ stats });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    twoPrefixes,
    new Set(),
    toChaos,
    toModFilterMap([{ text: "+144 to Evasion Rating", min: 100, max: 200 }])
  );

  // A max of 200 here would be a ceiling below the item's own 193 total, excluding the item from its
  // own comparables — worse than having no ceiling at all.
  // 100 from the bound, 49 from the affix that was left alone — but no ceiling, because only one of
  // the two supplied one.
  assert.deepEqual(statFiltersOf(calls), [{ id: "explicit.stat_EVASION", value: { min: 149 } }]);
});

test("a stat GGG indexes without a number takes no bound even when one is offered", async () => {
  const stats = {
    result: [
      {
        id: "explicit",
        entries: [
          { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
          { id: "explicit.stat_1penalty", text: "Cannot be Frozen", type: "explicit" }
        ]
      },
      { id: "implicit", entries: [] }
    ]
  };
  const item = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      "--------\n+80 to maximum Life\nCannot be Frozen"
  );
  const { fetch, calls } = stubFetch({ stats });
  // The editor renders no boxes for a line with no number, so this can only arrive from a stale or
  // hand-edited cache — and it must still not reach GGG as a threshold on a presence-only stat.
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    item,
    new Set(),
    toChaos,
    toModFilterMap([{ text: "Cannot be Frozen", min: 5, max: null }])
  );

  assert.deepEqual(statFiltersOf(calls), [
    { id: "explicit.stat_3299347043", value: { min: 80 } },
    { id: "explicit.stat_1penalty" }
  ]);
});

test("toModFilterMap drops what can't be serialised and keeps what legitimately can be", () => {
  const map = toModFilterMap([
    // NaN and Infinity both stringify to `null`, which is the shape that zeroes a search.
    { text: "a", min: Number.NaN, max: Number.POSITIVE_INFINITY },
    // Negative rolls are ordinary — the stat templates match a leading minus — so these stay.
    { text: "b", min: -15, max: -5 },
    // An inverted range matches nothing; the floor alone is the useful half.
    { text: "c", min: 90, max: 10 },
    { text: "", min: 1, max: 2 }
  ] as ModFilter[]);

  assert.deepEqual(map.get("a"), { min: null, max: null });
  assert.deepEqual(map.get("b"), { min: -15, max: -5 });
  assert.deepEqual(map.get("c"), { min: 90, max: null });
  assert.equal(map.has(""), false);
});

test("the automatic pricing path sends exactly what it did before bounds existed", async () => {
  const withoutArg = stubFetch();
  await new Trade2Client(makeSettings(), withoutArg.fetch).estimateRareValue(RARE, new Set(), toChaos);

  const withEmpty = stubFetch();
  await new Trade2Client(makeSettings(), withEmpty.fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos,
    toModFilterMap([])
  );

  assert.deepEqual(statFiltersOf(withoutArg.calls), statFiltersOf(withEmpty.calls));
  assert.deepEqual(statFiltersOf(withoutArg.calls), [
    { id: "explicit.stat_3299347043", value: { min: 80 } },
    { id: "explicit.stat_4220027924", value: { min: 45 } }
  ]);
});

// ---------------------------------------------------------------------------
// Waystones: searched on their reward totals
// ---------------------------------------------------------------------------

/** The real capture from the log this came from: 0 listings at 6 of 6 mods, 118 at 3 of 6. */
const WAYSTONE = parse(
  "Item Class: Waystones\nRarity: Rare\nGhost Frontier\nWaystone (Tier 15)\n--------\n" +
    "Revives Available: 0 (augmented)\nItem Rarity: +24% (augmented)\nPack Size: +7% (augmented)\n" +
    "Monster Rarity: +18% (augmented)\nMonster Effectiveness: +13% (augmented)\n" +
    "Waystone Drop Chance: +85% (augmented)\n--------\nItem Level: 82\n--------\n" +
    "+82 to maximum Life\nMonsters are Armoured"
);

test("a waystone is searched on its reward totals, not on its affixes at all", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(WAYSTONE, new Set(), toChaos);

  const { query } = JSON.parse(String(searchCall(calls).init.body));

  // floor(x * 0.9) on the four reward stats. Measured live: this shape returned 3453 listings for
  // this waystone while its six real affixes returned 0.
  assert.deepEqual(query.filters.map_filters.filters, {
    map_iir: { min: 21 },
    map_packsize: { min: 6 },
    map_rare_monsters: { min: 16 },
    map_bonus: { min: 76 }
  });

  // No stat group whatsoever — the affixes are dropped wholesale rather than folded one by one,
  // because collectively they *are* the reward block.
  assert.equal(query.stats, undefined, "the affixes must not be searched");
});

test("monster effectiveness, revives and tier are deliberately not filtered", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(WAYSTONE, new Set(), toChaos);

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;

  // Effectiveness and revives are difficulty, which is a cost to the buyer — a floor on them would
  // exclude the easier waystones that are worth more.
  assert.equal(filters.map_filters.filters.map_magic_monsters, undefined);
  assert.equal(filters.map_filters.filters.map_revives, undefined);
  // Tier needs no filter: measured live, `type: "Waystone (Tier 15)"` with map_tier min 16 returns
  // zero listings, so the base type already pins it exactly.
  assert.equal(filters.map_filters.filters.map_tier, undefined);
});

test("nothing at the reward floors falls back to the tier alone, and says so", async () => {
  const { fetch, calls } = stubFetch({
    stats: STATS_RES,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    WAYSTONE,
    new Set(),
    toChaos
  );

  const searches = calls.filter((call) => call.url.includes("/search/"));
  assert.equal(searches.length, 2);
  assert.equal(JSON.parse(String(searches[1]!.init.body)).query.filters, undefined);
  assert.equal(estimate.chaosValue, 10);
  // Matters more here than the other drops: what's left is every waystone of this tier.
  assert.equal(estimate.mapDropped, true);
});

test("switched off, a waystone is searched on its affixes exactly as before", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings({ useMapFilters: false }), fetch).estimateRareValue(
    WAYSTONE,
    new Set(),
    toChaos
  );

  const { query } = JSON.parse(String(searchCall(calls).init.body));
  assert.equal(query.filters, undefined);
  assert.equal(query.stats[0].filters.length, 1, "the life mod is a stat filter again");
});

test("a non-waystone never gets map filters, whatever it rolled", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(JSON.parse(String(searchCall(calls).init.body)).query.filters, undefined);
});

// ---------------------------------------------------------------------------
// Which mods the priced listings actually carried
// ---------------------------------------------------------------------------

const coverageOf = (estimate: { statCoverage: Array<{ text: string; listings: number }> }) =>
  Object.fromEntries(estimate.statCoverage.map((entry) => [entry.text, entry.listings]));

test("counts how many of the priced listings carried each mod", async () => {
  // RARE has +80 life and +45% cold res. Of three listings: all three carry life, one carries cold.
  const { fetch } = stubFetch({
    hashesSequence: [
      { explicit: [["explicit.stat_3299347043", [0]]] },
      { explicit: [["explicit.stat_3299347043", [0]]] },
      {
        explicit: [
          ["explicit.stat_3299347043", [0]],
          ["explicit.stat_4220027924", [1]]
        ]
      }
    ]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  // The honest answer to "which mods was this price based on": the search asked for at least N of
  // them, and different listings carry different subsets, so this is a count and not a set.
  assert.deepEqual(coverageOf(estimate), {
    "+80 to maximum Life": 3,
    "+45% to Cold Resistance": 1
  });
  assert.equal(estimate.coverageSample, 3);
});

test("a stat carried as a different kind still counts", async () => {
  // Our item has life as an explicit; this listing has the same stat id as a crafted mod. Reading
  // only the matching group would undercount it to zero.
  const { fetch } = stubFetch({
    hashesSequence: [
      { crafted: [["explicit.stat_3299347043", [0]]] },
      { explicit: [] },
      { explicit: [] }
    ]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  assert.equal(coverageOf(estimate)["+80 to maximum Life"], 1);
});

test("two mod lines summing into one stat id are both credited", async () => {
  const stats = {
    result: [
      {
        id: "explicit",
        entries: [{ id: "explicit.stat_EVASION", text: "# to Evasion Rating", type: "explicit" }]
      },
      { id: "implicit", entries: [] }
    ]
  };
  const twoPrefixes = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      "--------\n+144 to Evasion Rating\n+49 to Evasion Rating"
  );
  const { fetch } = stubFetch({
    stats,
    hashesSequence: [{ explicit: [["explicit.stat_EVASION", [0]]] }, { explicit: [] }, { explicit: [] }]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    twoPrefixes,
    new Set(),
    toChaos
  );

  // One filter was sent, but two rows in the editor produced it, so both have to be told.
  assert.deepEqual(coverageOf(estimate), {
    "+144 to Evasion Rating": 1,
    "+49 to Evasion Rating": 1
  });
});

test("a listing carrying none of the mods leaves them all at zero rather than absent", async () => {
  const { fetch } = stubFetch({ hashesSequence: [{}, {}, {}] });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  // Zero is the informative case — it says the price rests on this mod not at all — so the entry has
  // to exist rather than being dropped and rendering as "no data".
  assert.deepEqual(coverageOf(estimate), {
    "+80 to maximum Life": 0,
    "+45% to Cold Resistance": 0
  });
});

// ---------------------------------------------------------------------------
// Pseudo aggregate filters
// ---------------------------------------------------------------------------

const STATS_RES = {
  result: [
    {
      id: "explicit",
      entries: [
        { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
        { id: "explicit.stat_4220027924", text: "#% to Cold Resistance", type: "explicit" },
        { id: "explicit.stat_3372524247", text: "#% to Fire Resistance", type: "explicit" },
        { id: "explicit.stat_1671376347", text: "#% to Lightning Resistance", type: "explicit" },
        { id: "explicit.stat_3917489142", text: "#% increased Rarity of Items found", type: "explicit" }
      ]
    },
    { id: "implicit", entries: [] }
  ]
};

/** The case this feature exists for: three resistance rolls nobody else has, in one 83% total. */
const RES_RARE = parse(
  "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n--------\n" +
    "+82 to maximum Life\n+38% to Cold Resistance\n+25% to Fire Resistance\n" +
    "+20% to Lightning Resistance\n15% increased Rarity of Items found"
);

const ELE_RES = "pseudo.pseudo_total_elemental_resistance";
const statsGroups = (calls: Call[]) => JSON.parse(String(searchCall(calls).init.body)).query.stats;

test("three resistance rolls are searched as one total, and stop being their own filters", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RES_RARE, new Set(), toChaos);

  const [count, pseudo] = statsGroups(calls);

  // floor(83 * 0.9). Below the item's own total for the same reason the defence floors are.
  assert.equal(pseudo.type, "and");
  assert.deepEqual(pseudo.filters, [{ id: ELE_RES, value: { min: 74 } }]);

  // The three resistances are gone from the count group — that is the fold. Leaving them would pin
  // the exact rolls the aggregate exists to get away from and undo the widening entirely.
  assert.equal(count.type, "count", "the count group has to stay at index 0");
  assert.deepEqual(count.filters.map((f: { id: string }) => f.id).sort(), [
    "explicit.stat_3299347043",
    "explicit.stat_3917489142"
  ]);
});

test("folding shortens the ladder and leaves the reported counts describing real mod filters", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RES_RARE,
    new Set(),
    toChaos
  );

  // Five filters would have laddered [5, 4, 3]; two ladder to [2]. The pseudo group must not enter
  // that arithmetic — it is always required, so it is never a threshold to relax.
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
  assert.equal(statsGroups(calls)[0].value.min, 2);
  assert.equal(estimate.totalMods, 2);
  assert.equal(estimate.matchedMods, 2);
  assert.equal(estimate.pseudoStats.length, 1);
  assert.equal(estimate.pseudoDropped, false);
});

test("unticking a contributor drops the aggregate back to individual filters", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RES_RARE,
    // Two resistances left is still an aggregate; take it to one and there is nothing to aggregate.
    new Set(["+38% to Cold Resistance", "+25% to Fire Resistance"]),
    toChaos
  );

  const groups = statsGroups(calls);
  assert.equal(groups.length, 1, "no pseudo group at all");
  assert.deepEqual(groups[0].filters.map((f: { id: string }) => f.id).sort(), [
    "explicit.stat_1671376347",
    "explicit.stat_3299347043",
    "explicit.stat_3917489142"
  ]);
});

test("unticking the aggregate itself hands its mods back", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  // The row editor's pseudo rows untick into the same list the mod rows do; a pseudo id can never
  // collide with a mod line, which is what makes sharing that list safe.
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RES_RARE, new Set([ELE_RES]), toChaos);

  const groups = statsGroups(calls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].filters.length, 5, "all five mods are individual filters again");
});

test("a bound set on a pseudo row replaces the derived floor", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(
    makeSettings(),
    fetch
  ).estimateRareValue(RES_RARE, new Set(), toChaos, new Map(), toModFilterMap([
    { text: ELE_RES, min: 60, max: 120 }
  ]));

  assert.deepEqual(statsGroups(calls)[1].filters, [{ id: ELE_RES, value: { min: 60, max: 120 } }]);
});

test("nothing at the aggregate retries once without it and says so", async () => {
  // Ladder is [2] here, so: one rung with the aggregate (empty), then the retry without it.
  const { fetch, calls } = stubFetch({
    stats: STATS_RES,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RES_RARE,
    new Set(),
    toChaos
  );

  const searches = calls.filter((call) => call.url.includes("/search/"));
  assert.equal(searches.length, 2);

  // The retry is the query this sent before aggregates existed, so it can only find listings the old
  // code would also have found — it can never invent a market.
  const retry = JSON.parse(String(searches[1]!.init.body)).query.stats;
  assert.equal(retry.length, 1, "the aggregate is gone from the retry");
  assert.equal(estimate.chaosValue, 10);
  assert.equal(estimate.pseudoDropped, true, "the badge and the status line both key off this");
  assert.deepEqual(estimate.pseudoStats, [], "nothing aggregate constrained the price that was used");
});

test("an item whose every mod folded still sends its pseudo group", async () => {
  const onlyRes = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      "--------\n+38% to Cold Resistance\n+25% to Fire Resistance"
  );
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    onlyRes,
    new Set(),
    toChaos
  );

  // `stats` used to be omitted wholesale whenever there were no ordinary mod filters, which would
  // have silently thrown this item's only real constraint away.
  const groups = statsGroups(calls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, "and");
  assert.deepEqual(groups[0].filters, [{ id: ELE_RES, value: { min: 56 } }]);
  assert.equal(estimate.chaosValue, 10);
});

test("switched off, an item with resistances sends exactly the payload it always did", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings({ usePseudoFilters: false }), fetch).estimateRareValue(
    RES_RARE,
    new Set(),
    toChaos
  );

  const groups = statsGroups(calls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].filters.length, 5);
});

// ---------------------------------------------------------------------------
// Defence (equipment) filters
// ---------------------------------------------------------------------------

/** Life and fire res, plus the two armour stats — so a failure to fold them is visible as filters. */
const STATS_ARMOUR = {
  result: [
    {
      id: "explicit",
      entries: [
        { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
        { id: "explicit.stat_3372524247", text: "#% to Fire Resistance", type: "explicit" },
        { id: "explicit.stat_ARMOUR_FLAT", text: "# to Armour", type: "explicit" },
        { id: "explicit.stat_ARMOUR_INC", text: "#% increased Armour", type: "explicit" }
      ]
    },
    { id: "implicit", entries: [] }
  ]
};

/** The real capture this came from: 0 listings on all 4 mod filters, 0 on 3, 4 on 2. */
const ARMOUR_RARE = parse(
  "Item Class: Body Armours\nRarity: Rare\nEagle Guardian\nSoldier Cuirass\n--------\n" +
    "Quality: +20% (augmented)\nArmour: 1081 (augmented)\n--------\nItem Level: 81\n--------\n" +
    "+186 to Armour\n38% increased Armour\n+32% to Fire Resistance\n+80 to maximum Life"
);

test("an armour piece is searched on its total, not on the rolls that produced it", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_ARMOUR });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(ARMOUR_RARE, new Set(), toChaos);

  const { query } = JSON.parse(String(searchCall(calls).init.body));

  // floor(1081 * 0.9). Below the item's own value on purpose: at parity the only matches are items
  // strictly better than this one, and a median over those prices something the item isn't.
  assert.deepEqual(query.filters.equipment_filters.filters, { ar: { min: 972 } });

  // The two armour mods are gone from the stat list — that is the fix. Leaving them would pin this
  // item's exact rolls all over again and the equipment filter would buy nothing.
  assert.deepEqual(
    query.stats[0].filters.map((filter: { id: string }) => filter.id).sort(),
    ["explicit.stat_3299347043", "explicit.stat_3372524247"]
  );
});

test("folding the armour mods shortens the ladder instead of burning requests on empty rungs", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_ARMOUR });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    ARMOUR_RARE,
    new Set(),
    toChaos
  );

  // Four stat filters would have laddered [4, 3, 2] — three requests, the first two of which can
  // only ever return 0 because nobody else has these armour rolls. Two filters ladder to [2].
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
  assert.equal(estimate.totalMods, 2);
  assert.equal(estimate.chaosValue, 10);
  assert.deepEqual(estimate.defences, [{ id: "ar", min: 972 }]);
  assert.equal(estimate.defencesDropped, false);
});

test("a corrupted armour sends both filter groups, not one instead of the other", async () => {
  const corrupted = parse(
    "Item Class: Body Armours\nRarity: Rare\nEagle Guardian\nSoldier Cuirass\n--------\n" +
      "Armour: 1000\n--------\nItem Level: 81\n--------\n+80 to maximum Life\n--------\nCorrupted"
  );
  const { fetch, calls } = stubFetch({ stats: STATS_ARMOUR });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(corrupted, new Set(), toChaos);

  // Both live under one `query.filters` key, so a conditional spread per group would have had the
  // second silently replace the first.
  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;
  assert.equal(filters.misc_filters.filters.corrupted.option, "true");
  assert.deepEqual(filters.equipment_filters.filters, { ar: { min: 900 } });
});

test("every displayed defence is filtered, since one mod can feed two of them", async () => {
  // "% increased Armour and Evasion" contributes to both totals; filtering only armour would throw
  // the evasion half away and search it with nothing.
  const hybrid = parse(
    "Item Class: Body Armours\nRarity: Rare\nGhoul Hide\nAdvanced Wayfarer Jacket\n--------\n" +
      "Armour: 500\nEvasion Rating: 400\nEnergy Shield: 100\nRunic Ward: 50\n--------\n" +
      "Item Level: 81\n--------\n+80 to maximum Life"
  );
  const { fetch, calls } = stubFetch({ stats: STATS_ARMOUR });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(hybrid, new Set(), toChaos);

  assert.deepEqual(JSON.parse(String(searchCall(calls).init.body)).query.filters.equipment_filters.filters, {
    ar: { min: 450 },
    ev: { min: 360 },
    es: { min: 90 },
    ward: { min: 45 }
  });
});

test("switched off, an armour piece sends exactly the payload it always did", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_ARMOUR, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings({ useDefenceFilters: false }), fetch).estimateRareValue(
    ARMOUR_RARE,
    new Set(),
    toChaos
  );

  const { query } = JSON.parse(String(searchCall(calls).init.body));
  assert.equal(query.filters, undefined);
  assert.equal(query.stats[0].filters.length, 4, "the armour mods are stat filters again");
});

test("an item with nothing but defence mods still gets a search, not a false 'no listings'", async () => {
  // Zero stat filters used to mean an empty ladder and a "no listings for base type" message about
  // a search that was never sent. Base type plus an armour floor is a real query.
  const onlyDefences = parse(
    "Item Class: Body Armours\nRarity: Rare\nEagle Guardian\nSoldier Cuirass\n--------\n" +
      "Armour: 1081\n--------\nItem Level: 81\n--------\n+186 to Armour\n38% increased Armour"
  );
  const { fetch, calls } = stubFetch({ stats: STATS_ARMOUR });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    onlyDefences,
    new Set(),
    toChaos
  );

  const { query } = JSON.parse(String(searchCall(calls).init.body));
  assert.deepEqual(query.filters.equipment_filters.filters, { ar: { min: 972 } });
  assert.equal(query.stats, undefined, "no mods left to ask for");
  assert.equal(estimate.chaosValue, 10);
});

test("nothing at this item's defences falls back to one search without them", async () => {
  // The ladder is [2] here, so: one rung with the armour floor (empty), then the retry without it.
  const { fetch, calls } = stubFetch({
    stats: STATS_ARMOUR,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    ARMOUR_RARE,
    new Set(),
    toChaos
  );

  const searches = calls.filter((call) => call.url.includes("/search/"));
  assert.equal(searches.length, 2);

  // The retry is the exact query this sent before defence filters existed, so it can only find
  // listings the old code would also have found.
  const retry = JSON.parse(String(searches[1]!.init.body)).query;
  assert.equal(retry.filters, undefined);
  assert.equal(retry.stats[0].value.min, 2);

  assert.equal(estimate.chaosValue, 10);
  assert.equal(estimate.defencesDropped, true, "the row badge and the log both key off this");
  assert.deepEqual(estimate.defences, [], "nothing constrained the price that was actually used");
});

test("a base with no market is still reported as such, after the defences were retried without", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_ARMOUR, searchIdsSequence: NO_LISTINGS });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    ARMOUR_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, null);
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 2);
  // By here the armour floor has already been ruled out as the cause, so the message must not
  // blame it — it points at the mods, which is what the user can actually loosen.
  assert.doesNotMatch(estimate.reason!, /Armour/);
  assert.match(estimate.reason!, /untick the rare mods/);
});

test("a defence a rare doesn't display never becomes a filter", async () => {
  // RARE is a Sapphire Ring: no property block, so no defences and no equipment_filters. This is
  // also what keeps a *global* "+N to maximum Energy Shield" on jewellery a stat filter.
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(JSON.parse(String(searchCall(calls).init.body)).query.filters, undefined);
});

test("requiredModMatches keeps every filter for one- and two-mod items", () => {
  // Halving these would discard the only signal a sparse item has.
  assert.equal(requiredModMatches(1, 0.5), 1);
  assert.equal(requiredModMatches(2, 0.5), 2);
  assert.equal(requiredModMatches(3, 0.5), 2);
  assert.equal(requiredModMatches(4, 0.5), 2);
  assert.equal(requiredModMatches(5, 0.5), 3);
  assert.equal(requiredModMatches(6, 0.5), 3);
  // Never above the number of filters actually sent, whatever the ratio.
  assert.equal(requiredModMatches(3, 2), 3);
  assert.equal(requiredModMatches(0, 0.5), 0);
});

test("caps the fetch id list at 10, which is where GGG starts rejecting the request", async () => {
  const ids = Array.from({ length: 25 }, (_, index) => `id-${index}`);
  const { fetch, calls } = stubFetch({ searchIds: ids });
  await new Trade2Client(makeSettings({ maxListings: 20 }), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  const url = new URL(fetchCall(calls)!.url);
  const idSegment = url.pathname.split("/fetch/")[1];
  assert.equal(idSegment.split(",").length, 10);
});

test("the mod ladder runs strictest first and always ends on the floor", () => {
  // Four mods, floor of 2: try the exact item, then 3, then the old behaviour.
  assert.deepEqual(modLadder(4, 0.5, 3), [4, 3, 2]);
  // Six mods would be four rungs; the cap keeps the strict end and never drops the floor, since
  // dropping it would turn items the loose search could price into unpriced ones.
  assert.deepEqual(modLadder(6, 0.5, 3), [6, 5, 3]);
  assert.deepEqual(modLadder(6, 0.5, 10), [6, 5, 4, 3]);
  // Items already at their floor have one rung — the same single search as before.
  assert.deepEqual(modLadder(2, 0.5, 3), [2]);
  assert.deepEqual(modLadder(1, 0.5, 3), [1]);
  // No matchable mods: one base-type-only search.
  assert.deepEqual(modLadder(0, 0.5, 3), [0]);
  // A cap of 1 disables the ladder entirely, and a nonsense cap can't produce an empty ladder.
  assert.deepEqual(modLadder(5, 0.5, 1), [3]);
  assert.deepEqual(modLadder(5, 0.5, 0), [3]);
});

test("a rare is priced off every one of its mods when listings exist for that", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_5 });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.matchedMods, 5);
  assert.equal(estimate.totalMods, 5);
  // The strict rung hit, so it costs exactly what the old single-threshold search did.
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
  const body = JSON.parse(String(searchCall(calls).init.body));
  assert.equal(body.query.stats[0].value.min, 5);
});

test("it steps down a rung at a time and reports which one paid off", async () => {
  // Nothing carries all five mods, nothing carries four, three is where the market starts.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], [], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, 10);
  assert.equal(estimate.matchedMods, 3);
  assert.equal(estimate.totalMods, 5);

  const thresholds = calls
    .filter((call) => call.url.includes("/search/"))
    .map((call) => JSON.parse(String(call.init.body)).query.stats[0].value.min);
  assert.deepEqual(thresholds, [5, 4, 3]);
});

test("one listing at the strict rung isn't a market, so the ladder keeps loosening", async () => {
  // The real shape this guards: a Ruby jewel had exactly one listing carrying all four of its mods
  // (at 30 chaos) and eleven sharing three. Taking the single one would report a stranger's asking
  // price as the item's value.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [["id-lonely"], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.matchedMods, 4);
  assert.equal(estimate.matches, 3);
  // Only the winning rung is fetched, however many rungs were searched.
  assert.equal(calls.filter((call) => call.url.includes("/fetch/")).length, 1);
});

test("the ladder reports what each rung matched, so a passed-over rung can be explained", async () => {
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [["id-lonely"], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  // "one listing carries all five mods" and "none does" are different things to tell the user.
  assert.deepEqual(estimate.rungs, [
    { required: 5, total: 1 },
    { required: 4, total: 3 }
  ]);
});

test("a thin market is still priced when no rung clears the bar", async () => {
  // Nothing anywhere has three listings, so the loosest non-empty rung is taken rather than nothing:
  // an approximate price beats a blank, which is the whole premise of trade2 pricing here.
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a"], ["id-a", "id-b"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.matchedMods, 3);
  assert.equal(estimate.chaosValue, 10);
});

test("an empty ladder blames the loosest rung, not the strictest, and names what it tried", async () => {
  const { fetch } = stubFetch({ stats: STATS_5, searchIdsSequence: [[], [], []] });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, null);
  // The question this wording exists to pre-empt: "why not just require all the mods?"
  assert.match(estimate.reason!, /3 or more of its 5 mods/);
  assert.match(estimate.reason!, /tried 5, 4, 3/);
});

test("running out of budget mid-ladder says so rather than reporting no market", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_5, searchIdsSequence: [[], [], []] });
  // Two slots: the strict rung, then one step down, then nothing left to descend with.
  const estimate = await new Trade2Client(
    makeSettings({ maxSearchesPerWindow: 2 }),
    fetch
  ).estimateRareValue(FIVE_MOD_RARE, new Set(), toChaos);

  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 2);
  assert.match(estimate.reason!, /budget ran out before trying fewer/);
});

test("samples the cheapest of the price-sorted results", () => {
  const ids = Array.from({ length: 100 }, (_, index) => index);

  // Deliberately the market floor: what undercutters are asking, not what the item is worth. On the
  // jewel this was measured against, ids 0-4 are five straight 1-exalted dump listings while the
  // middle of the same window runs ~30. See `priceSample` for why that is the intended reading.
  assert.deepEqual(priceSample(ids, 5), [0, 1, 2, 3, 4]);
  // Thin bases keep everything they have rather than being narrowed further.
  assert.deepEqual(priceSample([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(priceSample([1, 2, 3], 3), [1, 2, 3]);
  assert.deepEqual(priceSample([], 5), []);
});

test("the cheapest ids are the ones fetched", async () => {
  const ids = Array.from({ length: 25 }, (_, index) => `id-${index}`);
  const { fetch, calls } = stubFetch({ searchIds: ids });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  const idSegment = new URL(fetchCall(calls)!.url).pathname.split("/fetch/")[1];
  assert.equal(idSegment, ids.slice(0, 5).join(","));
});

test("the fetch call carries the query id and realm the trade site sends", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  const url = new URL(fetchCall(calls)!.url);
  assert.equal(url.searchParams.get("query"), "query-123");
  assert.equal(url.searchParams.get("realm"), "poe2");
});

test("an empty result blames the mod filters, since that's what the user can loosen", async () => {
  const { fetch, calls } = stubFetch({ searchIds: [] });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, null);
  assert.match(estimate.reason!, /untick/);
  assert.equal(fetchCall(calls), undefined, "nothing to fetch — the second request must be skipped");
});

test("a base-type-only search says so instead of blaming filters it never sent", async () => {
  const { fetch } = stubFetch({ searchIds: [] });
  const noMods = parse("Item Class: Rings\nRarity: Rare\nPlain Thing\nSapphire Ring\n--------\nItem Level: 60");
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(noMods, new Set(), toChaos);

  assert.match(estimate.reason!, /no online listings for base type "Sapphire Ring"/);
});

test("a 429 is reported as a rate limit, naming the setting that controls it", async () => {
  const { fetch } = stubFetch({ searchStatus: 429, retryAfter: "60" });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, null);
  assert.match(estimate.reason!, /rate-limited/);
  assert.match(estimate.reason!, /retry after 60s/);
  assert.match(estimate.reason!, /maxSearchesPerWindow/);
});

test("a 502 is retried and the item still gets a price", async () => {
  // The exact case from a live run: GGG returned 502 on trade2 and the currency exchange in the
  // same second. Without a retry that blip stored the rare unpriced permanently, which reads
  // identically to "this base has no market".
  const { fetch, calls } = stubFetch({ searchStatusSequence: [502, 200] });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, 10);
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 2);
});

test("a dropped socket is retried too", async () => {
  const { fetch } = stubFetch({ throwOnSearch: 1 });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, 10);
});

test("a persistent 5xx gives up after the configured attempts and says so", async () => {
  const { fetch, calls } = stubFetch({ searchStatus: 503 });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, null);
  assert.match(estimate.reason!, /HTTP 503/);
  assert.match(estimate.reason!, /gave up after 2 attempts/);
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 2);
});

test("a 4xx is not retried — the query was rejected and will be again", async () => {
  const { fetch, calls } = stubFetch({ searchStatus: 400 });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
});

test("a 429 is not retried — waiting out GGG's Retry-After would stall the queue", async () => {
  const { fetch, calls } = stubFetch({ searchStatus: 429, retryAfter: "60" });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
  assert.match(estimate.reason!, /rate-limited/);
});

test("retries spend budget, and a budget-exhausted retry still reports the real failure", async () => {
  const { fetch } = stubFetch({ searchStatus: 502 });
  // One slot: the first attempt takes it, so the retry can't run.
  const estimate = await new Trade2Client(
    makeSettings({ maxSearchesPerWindow: 1 }),
    fetch
  ).estimateRareValue(RARE, new Set(), toChaos);

  assert.match(estimate.reason!, /HTTP 502/, "the 502 is the actionable fact, not the budget");
  assert.match(estimate.reason!, /no budget left to retry/);
});

test("retrying can be switched off", async () => {
  const { fetch, calls } = stubFetch({ searchStatus: 502 });
  await new Trade2Client(makeSettings({ maxTransientRetries: 0 }), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
});

test("an HTTP error surfaces GGG's own error message", async () => {
  const { fetch } = stubFetch({ searchStatus: 400 });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.match(estimate.reason!, /HTTP 400/);
  assert.match(estimate.reason!, /Invalid query/);
});

test("listings whose currency can't be converted don't become a wrong price", async () => {
  const { fetch } = stubFetch({ listings: [{ amount: 3, currency: "some-unknown-orb" }, null] });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, null);
  assert.match(estimate.reason!, /none had a price this app could convert/);
});

test("switched off, it makes no request at all and says why", async () => {
  const { fetch, calls } = stubFetch();
  const client = new Trade2Client(makeSettings({ enabled: false }), fetch);
  const estimate = await client.estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(client.isAvailable, false);
  assert.equal(calls.length, 0);
  assert.match(estimate.reason!, /switched off/);
});

test("declines once the search budget is spent, rather than stalling on a rate limit", async () => {
  const { fetch } = stubFetch();
  const client = new Trade2Client(makeSettings({ maxSearchesPerWindow: 2 }), fetch);

  assert.equal((await client.estimateRareValue(RARE, new Set(), toChaos)).chaosValue, 10);
  assert.equal((await client.estimateRareValue(RARE, new Set(), toChaos)).chaosValue, 10);

  const third = await client.estimateRareValue(RARE, new Set(), toChaos);
  assert.equal(third.chaosValue, null);
  assert.match(third.reason!, /budget spent/);
  assert.match(third.reason!, /Reprice/, "the message must name the way to retry");
});
