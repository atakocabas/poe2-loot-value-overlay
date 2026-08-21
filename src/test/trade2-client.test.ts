import assert from "node:assert/strict";
import { test } from "node:test";
import {
  droppableFilters,
  searchRungs,
  Trade2Client,
  priceSample,
  minSurvivingFilters,
  toModFilterMap
} from "../pricing/trade2-client";
import type { GggFetch } from "../pricing/ggg-fetch";
import { parseItemText } from "../parser/item-text-parser";
import { tradeSearchUrl } from "../shared/trade-link";
import type { ModFilter, ParsedItem } from "../shared/types";
import type { Settings } from "../shared/settings";

const STATS = {
  result: [
    {
      id: "explicit",
      entries: [
        { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
        { id: "explicit.stat_1050105434", text: "# to maximum Mana", type: "explicit" }
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
  /**
   * GGG's *query* id per successive search call — the `?query=` value, not the listing ids above.
   * Only worth setting when a test needs to tell one rung's search from another's.
   */
  queryIds?: string[];
  searchStatus?: number;
  fetchStatus?: number;
  listings?: Array<{ amount: number; currency: string } | null>;
  /**
   * `listing.indexed` per listing, in the same order as `listings` — GGG's ISO-8601 for when the
   * listing went up. Omitted entirely by default, which is the case the row has to survive: a
   * response with no dates must price normally and simply draw no age.
   */
  indexedSequence?: Array<string | undefined>;
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
        JSON.stringify({
          id: options.queryIds?.[attempt] ?? "query-123",
          result,
          total: options.searchTotal ?? result.length
        }),
        { status: 200 }
      );
    }
    if (fetchStatus !== 200) {
      return new Response(JSON.stringify({ error: { code: 3, message: "Nope" } }), { status: fetchStatus });
    }
    return new Response(
      JSON.stringify({
        result: listings.map((price, index) => ({
          listing: {
            price,
            ...(options.indexedSequence?.[index] !== undefined
              ? { indexed: options.indexedSequence[index] }
              : {})
          },
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
      // Both halves of the budget, at their real defaults. Omitting these left `TradeSearchBudget`
      // with `{ max: undefined, windowMs: undefined }` for its second window, which makes
      // `longestWindowMs` NaN — so its pruning loop never ran and `cooldownMs()` returned NaN. The
      // long window is loose enough (240 per 6h) never to bind in a test, which is why it went
      // unnoticed: nothing asked the budget a question the short window couldn't answer.
      maxSearchesPerLongWindow: 240,
      longWindowMs: 21600000,
      // 0 so the tests never actually sleep; the spacing itself is covered in trade-budget.test.ts.
      minSearchIntervalMs: 0,
      maxListings: 5,
      listingStatus: "online",
      saleType: "buyout",
      useModDropLadder: true,
      maxModDropSearches: 5,
      modDropTierThreshold: 3,
      minListingsForMatch: 3,
      minModMatchRatio: 0.5,
      useDefenceFilters: true,
      useWeaponFilters: true,
      defenceMinRatio: 0.9,
      usePseudoFilters: true,
      pseudoMinRatio: 0.9,
      useMapFilters: true,
      mapMinRatio: 0.9,
      useBaseItemSearch: true,
      baseItemMinLevel: 81,
      minListingPrice: 0,
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
    "--------\n+80 to maximum Life\n+45 to maximum Mana"
);

/**
 * The same five mods, but copied with Advanced Item Descriptions on, so each carries a tier. Life is
 * T1 and must survive; rarity is T5 and is the first thing the ladder should be willing to lose.
 */
const FIVE_MOD_RARE_TIERED = parse(
  "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n--------\n" +
    '{ Prefix Modifier "Sanguine" (Tier: 1) — Life }\n+82 to maximum Life\n' +
    '{ Suffix Modifier "of Sighting" (Tier: 2) — Attack }\n12% increased Attack Speed\n' +
    '{ Suffix Modifier "of Talent" (Tier: 3) — Caster }\n9% increased Cast Speed\n' +
    '{ Prefix Modifier "of the Hawk" (Tier: 4) — Attack }\n+150 to Accuracy Rating\n' +
    '{ Suffix Modifier "of Plunder" (Tier: 5) — Rarity }\n15% increased Rarity of Items found'
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
/**
 * How many filters a stats group actually demands — every enabled one, since both group types ignore
 * the disabled rows the ladder sends along for the "View search" link.
 *
 * This is the number `value.min` used to carry when the group was a `count`. Measured live on one
 * `Sapphire Ring` query with three enabled filters and two disabled: `count` with `min: 3` and `and`
 * both answered **4525**, as did `and` over the three enabled filters alone. So the shape changed and
 * the demand did not, which is what these assertions are checking.
 */
const demanded = (group: { filters: Array<{ disabled?: boolean }> }): number =>
  group.filters.filter((filter) => !filter.disabled).length;
const firstStatsGroup = (call: Call): { type: string; filters: Array<{ disabled?: boolean }> } =>
  JSON.parse(String(call.init.body)).query.stats[0];
const fetchCall = (calls: Call[]): Call | undefined =>
  calls.find((call) => call.url.includes("/fetch/"));

test("prices a rare at the cheapest listing of the sample", async () => {
  const { fetch } = stubFetch();
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  // 1, 5, 10 exalted -> 2, 10, 20 chaos. The price is the floor: what you could undercut into today.
  assert.equal(estimate.chaosValue, 2);
  assert.equal(estimate.reason, null);
  assert.equal(estimate.listings, 3);
  assert.equal(estimate.matches, 3);
});

test("reports the full match count alongside the sample the price came from", async () => {
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
    new Set(["+45 to maximum Mana"]),
    toChaos
  );

  const body = JSON.parse(String(searchCall(calls).init.body));
  assert.equal(body.query.type, "Sapphire Ring");
  // `and`, with no `value` at all: the group demands every filter it carries, and says so directly
  // rather than through a threshold that happens to equal the filter count.
  assert.deepEqual(body.query.stats, [
    { type: "and", filters: [{ id: "explicit.stat_3299347043", value: { min: 80 } }] }
  ]);
  assert.equal(body.sort.price, "asc");
});

test("a five-mod rare falls back to requiring only three, which is what makes it findable at all", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_5, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(FIVE_MOD_RARE, new Set(), toChaos);

  // The ladder's last rung, which is the only query this sent before the strict rungs existed.
  const [stats] = JSON.parse(String(lastSearchCall(calls).init.body)).query.stats;

  // Three of the five mods, demanded together. The other two ride along `disabled: true` so the
  // "View search" link opens the whole mod table with them visibly unticked — GGG ignores them when
  // matching, which is why `and` over this payload answers exactly what `count` with `min: 3` did.
  assert.equal(stats.type, "and");
  assert.equal(stats.value, undefined, "an `and` group carries no threshold to relax");
  assert.equal(demanded(stats), 3);
  assert.equal(stats.filters.length, 5, "the two it shed are still sent, disabled, for the link");
});

test("the required-match count is reported so the log explains a miss", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_5, searchIds: [] });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  // "as few as", not "3 or more": every rung demanded all of what it sent, so the loosest asked for
  // three specific mods rather than any three of five.
  assert.match(estimate.reason!, /as few as 3 of its 5 mods/);
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
  assert.equal(demanded(firstStatsGroup(lastSearchCall(strict.calls))), 5);

  const loose = stubFetch({ stats: STATS_5, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings({ minModMatchRatio: 0.2 }), loose.fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );
  assert.equal(demanded(firstStatsGroup(lastSearchCall(loose.calls))), 2);
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

test("the status filter is sent verbatim, including the instant-buyout options", async () => {
  // GGG's `status` is not an online/offline toggle: `securable` is Instant Buyout, `online` is
  // In Person (Online). Confirmed against /api/trade2/data/filters, and all five are accepted live.
  for (const status of ["securable", "available", "online", "onlineleague", "any"] as const) {
    const { fetch, calls } = stubFetch({ searchIds: [] });
    await new Trade2Client(makeSettings({ listingStatus: status }), fetch).estimateRareValue(
      RARE,
      new Set(),
      toChaos
    );

    assert.equal(JSON.parse(String(searchCall(calls).init.body)).query.status.option, status);
  }
});

test("a no-match message names the listings it actually searched", async () => {
  // The old wording said "online listings" for everything except `any`, which read as an
  // online/offline distinction and hid the fact that instant-buyout listings were being excluded.
  const labels: Record<string, RegExp> = {
    securable: /no instant-buyout listings/,
    available: /no instant-buyout or in-person listings/,
    online: /no in-person listings from online sellers/,
    any: /no listings/
  };

  for (const [status, pattern] of Object.entries(labels)) {
    const { fetch } = stubFetch({ searchIds: [] });
    const estimate = await new Trade2Client(
      makeSettings({ listingStatus: status as "securable" }),
      fetch
    ).estimateRareValue(RARE, new Set(), toChaos);

    assert.match(estimate.reason!, pattern, `wrong wording for status=${status}`);
  }
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

test("buyout-only sends no sale_type at all, because that is what omitting it means", async () => {
  // Measured against the live API on an `Alpha Talisman` search: omitting `sale_type` returned 239
  // listings, `sale_type: unpriced` 93, and `sale_type: any` 332 — exactly 239 + 93. GGG's filter
  // reference agrees, giving "Buyout or Fixed Price" the `null` id, i.e. "nothing sent". Sending
  // that null explicitly is a 400, so the default *must* be expressed as an absence.
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings({ saleType: "buyout" }), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;
  assert.equal(filters?.trade_filters, undefined);
});

test("counting any listing is the opt-out, and it is the only case that sends the filter", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings({ saleType: "any" }), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;
  assert.equal(filters.trade_filters.filters.sale_type.option, "any");
});

test("the sale type rides alongside the other filter groups rather than replacing them", async () => {
  // All four groups share one `query.filters` key, which is why they are assembled into one object.
  // A corrupted item counting any listing has to send both.
  const corrupted = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      "--------\n+80 to maximum Life\n--------\nCorrupted"
  );
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings({ saleType: "any" }), fetch).estimateRareValue(
    corrupted,
    new Set(),
    toChaos
  );

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;
  assert.equal(filters.misc_filters.filters.corrupted.option, "true");
  assert.equal(filters.trade_filters.filters.sale_type.option, "any");
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
  assert.equal(demanded(stat), 1, "one distinct stat, so one filter demanded");
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
    { id: "explicit.stat_1050105434", value: { min: 45 } }
  ]);
});

test("a mod is searched partway down its own roll bracket, not at its exact roll", async () => {
  // Two real jewels matched **0** listings on all four of their mods, purely because every stat was
  // pinned to the item's own number and the only matches were items strictly better on every one.
  // The bracket the game prints is what says how good a roll is; see `searchFloor`.
  const bracketed = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 78\n" +
      "--------\n" +
      '{ Prefix Modifier "Sanguine" (Tier: 1) - Life }\n+80(60-100) to maximum Life'
  );
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(bracketed, new Set(), toChaos);

  // 60 + (80 - 60) / 2. The roll is still what the row displays and what the editor prefills from.
  assert.deepEqual(statFiltersOf(calls), [{ id: "explicit.stat_3299347043", value: { min: 70 } }]);
});

test("a mod with no printed bracket is still floored at its own roll", async () => {
  // Every capture made without Advanced Item Descriptions, and everything in loot-cache.json from
  // before the bracket was parsed. Degraded, not disabled — exactly the pre-feature query.
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.deepEqual(statFiltersOf(calls), [
    { id: "explicit.stat_3299347043", value: { min: 80 } },
    { id: "explicit.stat_1050105434", value: { min: 45 } }
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
    { id: "explicit.stat_1050105434", value: { min: 45 } }
  ]);
});

// ---------------------------------------------------------------------------
// Waystones: searched on their printed totals
// ---------------------------------------------------------------------------

/** The real capture from the log this came from: 0 listings at 6 of 6 mods, 118 at 3 of 6. */
const WAYSTONE = parse(
  "Item Class: Waystones\nRarity: Rare\nGhost Frontier\nWaystone (Tier 15)\n--------\n" +
    "Revives Available: 0 (augmented)\nItem Rarity: +24% (augmented)\nPack Size: +7% (augmented)\n" +
    "Monster Rarity: +18% (augmented)\nMonster Effectiveness: +13% (augmented)\n" +
    "Waystone Drop Chance: +85% (augmented)\n--------\nItem Level: 82\n--------\n" +
    "+82 to maximum Life\nMonsters are Armoured"
);

test("a waystone is searched on its printed totals, not on its affixes at all", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(WAYSTONE, new Set(), toChaos);

  const { query } = JSON.parse(String(searchCall(calls).init.body));

  // floor(x * 0.9) on the rewards, ceil(x / 0.9) on the difficulty. Measured live: the reward half
  // of this shape returned 3453 listings while the waystone's six real affixes returned 0.
  assert.deepEqual(query.filters.map_filters.filters, {
    map_iir: { min: 21 },
    map_packsize: { min: 6 },
    map_rare_monsters: { min: 16 },
    map_bonus: { min: 76 },
    map_magic_monsters: { max: 15 }
  });

  // No stat group whatsoever — the affixes are dropped wholesale rather than folded one by one,
  // because collectively they *are* the printed block.
  assert.equal(query.stats, undefined, "the affixes must not be searched");
});

test("monster effectiveness is a ceiling, never a floor", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(WAYSTONE, new Set(), toChaos);

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;

  // Difficulty is a cost to the buyer, so the comparables are the waystones at *most* this dangerous.
  // A floor here is the bug this replaced: it excluded the easier maps, which are worth more.
  assert.deepEqual(filters.map_filters.filters.map_magic_monsters, { max: 15 });
  assert.equal(
    filters.map_filters.filters.map_magic_monsters.min,
    undefined,
    "a floor on difficulty prices the item upside down"
  );
});

test("a floor at zero is culled, and revives is a floor", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  // This waystone prints `Revives Available: 0`. More revives is a benefit, so it takes a floor like
  // the rewards do — and a floor of 0 asks for nothing every listing doesn't already satisfy.
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(WAYSTONE, new Set(), toChaos);
  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;
  assert.equal(filters.map_filters.filters.map_revives, undefined);

  const revived = parse(WAYSTONE.rawText.replace("Revives Available: 0", "Revives Available: 6"));
  const second = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), second.fetch).estimateRareValue(revived, new Set(), toChaos);
  const query = JSON.parse(String(searchCall(second.calls).init.body)).query;
  assert.deepEqual(query.filters.map_filters.filters.map_revives, { min: 5 });
});

test("a ceiling of zero survives, unlike a floor of zero", async () => {
  // 0% effectiveness is the *best* case and the one worth the most, so the constraint has to be sent.
  // Culling it the way a zero floor is culled would drop the filter on exactly those waystones.
  const easy = parse(WAYSTONE.rawText.replace("Monster Effectiveness: +13%", "Monster Effectiveness: +0%"));
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(easy, new Set(), toChaos);

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;
  assert.deepEqual(filters.map_filters.filters.map_magic_monsters, { max: 0 });
});

test("a bound typed in the row editor wins over the computed ceiling", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    WAYSTONE,
    new Set(),
    toChaos,
    new Map(),
    new Map(),
    new Map([["map_magic_monsters", { text: "map_magic_monsters", min: null, max: 40 }]])
  );

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;
  assert.deepEqual(filters.map_filters.filters.map_magic_monsters, { max: 40 });
});

test("the waystone tier is deliberately not filtered", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(WAYSTONE, new Set(), toChaos);

  const { filters } = JSON.parse(String(searchCall(calls).init.body)).query;

  // Measured live, `type: "Waystone (Tier 15)"` with map_tier min 16 returns zero listings, so the
  // base type already pins the tier exactly. Unchanged by the difficulty filter above.
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
  assert.equal(estimate.chaosValue, 2);
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
  // RARE has +80 life and +45 mana. Of three listings: all three carry life, one carries mana.
  const { fetch } = stubFetch({
    hashesSequence: [
      { explicit: [["explicit.stat_3299347043", [0]]] },
      { explicit: [["explicit.stat_3299347043", [0]]] },
      {
        explicit: [
          ["explicit.stat_3299347043", [0]],
          ["explicit.stat_1050105434", [1]]
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
    "+45 to maximum Mana": 1
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
    "+45 to maximum Mana": 0
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

  const [mods, pseudo] = statsGroups(calls);

  // floor(83 * 0.9). Below the item's own total for the same reason the defence floors are.
  assert.equal(pseudo.type, "and");
  assert.deepEqual(pseudo.filters, [{ id: ELE_RES, value: { min: 74 } }]);

  // The three resistances are gone from the mod group — that is the fold. Leaving them would pin
  // the exact rolls the aggregate exists to get away from and undo the widening entirely.
  assert.equal(mods.type, "and", "the item's own mods stay at index 0");
  assert.deepEqual(mods.filters.map((f: { id: string }) => f.id).sort(), [
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
  assert.equal(demanded(statsGroups(calls)[0]), 2);
  assert.equal(estimate.totalMods, 2);
  assert.equal(estimate.matchedMods, 2);
  assert.equal(estimate.pseudoStats.length, 1);
  assert.equal(estimate.pseudoDropped, false);
});

test("unticking contributors until one element is left swaps the combined total for that element", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_RES });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RES_RARE,
    // Two of the three resistances gone, so the combined total no longer describes this item: what
    // is left is 20% lightning and nothing else.
    new Set(["+38% to Cold Resistance", "+25% to Fire Resistance"]),
    toChaos
  );

  const [mods, pseudo] = statsGroups(calls);
  // The lightning roll is still aggregated, just as itself — `pseudo_total_lightning_resistance` is
  // exactly what that mod says, and additionally finds listings reaching 20 through an all-elemental
  // roll. Measured live on `Sapphire Ring`: explicit fire >= 42 returned 9290 listings, the pseudo
  // 10000+.
  assert.deepEqual(pseudo.filters, [
    { id: "pseudo.pseudo_total_lightning_resistance", value: { min: 18 } }
  ]);
  assert.deepEqual(mods.filters.map((f: { id: string }) => f.id).sort(), [
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
  // The aggregate is still *sent* so the trade site shows the row, but disabled — GGG ignores it when
  // matching, so this is the same query as before aggregates existed while still being readable.
  assert.equal(retry.length, 2);
  assert.equal(retry[1].type, "and");
  assert.ok(retry[1].filters.every((filter: { disabled?: boolean }) => filter.disabled === true));
  assert.equal(estimate.chaosValue, 2);
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
  assert.equal(estimate.chaosValue, 2);
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
        { id: "explicit.stat_1050105434", text: "# to maximum Mana", type: "explicit" },
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
    "+186 to Armour\n38% increased Armour\n+32 to maximum Mana\n+80 to maximum Life"
);

test("an armour piece is searched on its total, not on the rolls that produced it", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_ARMOUR });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(ARMOUR_RARE, new Set(), toChaos);

  const { query } = JSON.parse(String(searchCall(calls).init.body));

  // floor(1081 * 0.9). Below the item's own value on purpose: at parity the only matches are items
  // strictly better than this one, and a price off those describes something the item isn't.
  assert.deepEqual(query.filters.equipment_filters.filters, { ar: { min: 972 } });

  // The two armour mods are gone from the stat list — that is the fix. Leaving them would pin this
  // item's exact rolls all over again and the equipment filter would buy nothing.
  assert.deepEqual(
    query.stats[0].filters.map((filter: { id: string }) => filter.id).sort(),
    ["explicit.stat_1050105434", "explicit.stat_3299347043"]
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
  assert.equal(estimate.chaosValue, 2);
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
  assert.equal(estimate.chaosValue, 2);
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
  assert.equal(demanded(retry.stats[0]), 2);

  assert.equal(estimate.chaosValue, 2);
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

// ---------------------------------------------------------------------------
// A weapon is searched on its elemental DPS
// ---------------------------------------------------------------------------

const STATS_WEAPON = {
  result: [
    {
      id: "explicit",
      entries: [
        { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
        { id: "explicit.stat_ELE_FLAT", text: "Adds # to # Fire Damage", type: "explicit" },
        { id: "explicit.stat_ELE_INC", text: "#% increased Elemental Damage", type: "explicit" }
      ]
    },
    { id: "implicit", entries: [] }
  ]
};

/**
 * 57 average elemental damage at 1.54 attacks per second — 87.78 eDPS.
 *
 * A quarterstaff rather than a wand, and the base matters: measured live, every `Attuned Wand`
 * listing has zero elemental DPS, because a wand's added elemental damage is spell damage. The
 * numbers come from a real `Bolting Quarterstaff` returned by an `edps >= 300` search.
 */
const WEAPON_RARE = parse(
  "Item Class: Quarterstaves\nRarity: Rare\nBrood Song\nBolting Quarterstaff\n--------\n" +
    "Physical Damage: 29-117\nElemental Damage: 45-69 (augmented)\nAttacks per Second: 1.54\n" +
    "--------\nItem Level: 79\n--------\n" +
    "Adds 45 to 69 Fire Damage\n35% increased Elemental Damage\n+80 to maximum Life"
);

test("a weapon is searched on its elemental DPS, not on the rolls that produced it", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_WEAPON });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(WEAPON_RARE, new Set(), toChaos);

  const { query } = JSON.parse(String(searchCall(calls).init.body));

  // floor(87.78 * 0.9). Below the item's own DPS for the same reason the armour floor is.
  assert.deepEqual(query.filters.equipment_filters.filters, { edps: { min: 79 } });

  // The flat fire roll is gone from the stat list — that is the fold, and the same fix armour got.
  // `#% increased Elemental Damage` stays: it does not move the printed line, so nothing else asks
  // for it.
  assert.deepEqual(
    query.stats[0].filters.map((filter: { id: string }) => filter.id).sort(),
    ["explicit.stat_3299347043", "explicit.stat_ELE_INC"]
  );
});

test("a folded elemental roll still counts as searched, through the DPS floor", async () => {
  const { fetch } = stubFetch({ stats: STATS_WEAPON });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    WEAPON_RARE,
    new Set(),
    toChaos
  );

  // It reached the query through `equipment_filters` rather than a stat id, which is still the price
  // resting on it — the row editor has to tick it.
  assert.ok(estimate.searchedMods.includes("Adds 45 to 69 Fire Damage"));
});

test("switched off, a weapon sends exactly the payload it always did", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_WEAPON, searchIdsSequence: NO_LISTINGS });
  await new Trade2Client(makeSettings({ useWeaponFilters: false }), fetch).estimateRareValue(
    WEAPON_RARE,
    new Set(),
    toChaos
  );

  const { query } = JSON.parse(String(searchCall(calls).init.body));
  assert.equal(query.filters, undefined);
  assert.equal(query.stats[0].filters.length, 3, "the fire roll is a stat filter again");
});

test("each fold is gated on its own floor, not on the shared filter list", async () => {
  // The two features share `equipment_filters` but not a switch. With the defences off and the weapon
  // on, an armour roll must stay a stat filter — folding it away would leave it constraining nothing.
  const armourOnAWeapon = parse(
    "Item Class: Quarterstaves\nRarity: Rare\nBrood Song\nBolting Quarterstaff\n--------\n" +
      "Armour: 200\nElemental Damage: 45-69\nAttacks per Second: 1.54\n--------\nItem Level: 79\n" +
      "--------\n+186 to Armour\nAdds 45 to 69 Fire Damage\n+80 to maximum Life"
  );
  const stats = {
    result: [
      {
        id: "explicit",
        entries: [
          { id: "explicit.stat_3299347043", text: "# to maximum Life", type: "explicit" },
          { id: "explicit.stat_ELE_FLAT", text: "Adds # to # Fire Damage", type: "explicit" },
          { id: "explicit.stat_ARMOUR_FLAT", text: "# to Armour", type: "explicit" }
        ]
      },
      { id: "implicit", entries: [] }
    ]
  };
  const { fetch, calls } = stubFetch({ stats });
  await new Trade2Client(
    makeSettings({ useDefenceFilters: false }),
    fetch
  ).estimateRareValue(armourOnAWeapon, new Set(), toChaos);

  const { query } = JSON.parse(String(searchCall(calls).init.body));
  assert.deepEqual(query.filters.equipment_filters.filters, { edps: { min: 79 } });
  assert.deepEqual(
    query.stats[0].filters.map((filter: { id: string }) => filter.id).sort(),
    ["explicit.stat_3299347043", "explicit.stat_ARMOUR_FLAT"],
    "the fire roll folded into the DPS floor; the armour roll had no floor to fold into"
  );
});

test("a white weapon sends no DPS floor, since its base type already pins it", async () => {
  // Same argument as the defences: a white base has no affixes for the floor to be measuring.
  const white = parse(
    "Item Class: Quarterstaves\nRarity: Normal\nBolting Quarterstaff\n--------\n" +
      "Elemental Damage: 45-69\nAttacks per Second: 1.54\n--------\nItem Level: 82"
  );
  const { fetch, calls } = stubFetch({ stats: STATS_WEAPON });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(white, new Set(), toChaos);

  assert.equal(
    JSON.parse(String(searchCall(calls).init.body)).query.filters.equipment_filters,
    undefined
  );
});

test("minSurvivingFilters keeps every filter for one- and two-mod items", () => {
  // Shedding from these would discard the only signal a sparse item has.
  assert.equal(minSurvivingFilters(1, 0.5), 1);
  assert.equal(minSurvivingFilters(2, 0.5), 2);
  assert.equal(minSurvivingFilters(3, 0.5), 2);
  assert.equal(minSurvivingFilters(4, 0.5), 2);
  assert.equal(minSurvivingFilters(5, 0.5), 3);
  assert.equal(minSurvivingFilters(6, 0.5), 3);
  // Never above the number of filters there are, whatever the ratio.
  assert.equal(minSurvivingFilters(3, 2), 3);
  assert.equal(minSurvivingFilters(0, 0.5), 0);
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

test("the drop order is worst affix first", () => {
  assert.deepEqual(
    droppableFilters(
      [
        { statId: "life", tiers: [1] },
        { statId: "fire", tiers: [5] },
        { statId: "lightning", tiers: [3] },
        { statId: "cold", tiers: [4] }
      ],
      3
    ),
    ["fire", "cold", "lightning", "life"]
  );
});

test("a filter is ranked by its best contributor, so one good roll protects the whole filter", () => {
  // A hybrid affix produces several mod lines summing into one stat id, and dropping the filter drops
  // all of them. Ranking by the worst would let a T5 line carry a T1 out of the search with it.
  assert.deepEqual(
    droppableFilters(
      [
        { statId: "evasion", tiers: [1, 5] },
        { statId: "resist", tiers: [4, 5] }
      ],
      3
    ),
    // evasion's best contributor is T1, so it lands in the known-good band and goes last.
    ["resist", "evasion"]
  );
});

test("an unknown tier is shed after the known-weak, not protected outright", () => {
  // It used to return [] here, which is what made the drop axis vanish without Advanced Item
  // Descriptions. With no count tail left to fall through to, that would strand such an item on a
  // single all-mods rung — so unknown is now a band, not a veto.
  assert.deepEqual(droppableFilters([{ statId: "a", tiers: [null] }], 1), ["a"]);
  assert.deepEqual(droppableFilters([{ statId: "a", tiers: [undefined] }], 1), ["a"]);
  // One unknown contributor still makes the whole filter a guess rather than a known-weak one, so it
  // goes after a filter that is known to be weak.
  assert.deepEqual(
    droppableFilters([{ statId: "a", tiers: [5, null] }, { statId: "b", tiers: [5] }], 3),
    ["b", "a"]
  );
  // No contributors at all is the unknown case too, not a vacuously worst-of-all one.
  assert.deepEqual(
    droppableFilters([{ statId: "a", tiers: [] }, { statId: "b", tiers: [4] }], 3),
    ["b", "a"]
  );
});

test("the drop order is three bands: known-weak, unknown, then known-good", () => {
  const filters = [
    { statId: "good1", tiers: [1] },
    { statId: "weak5", tiers: [5] },
    { statId: "unknown", tiers: [null] },
    { statId: "good2", tiers: [2] },
    { statId: "weak4", tiers: [4] }
  ];

  // Shed what is known to be weak, then what nothing is known about, then what is known to be good.
  assert.deepEqual(droppableFilters(filters, 3), [
    "weak5",
    "weak4",
    "unknown",
    "good2",
    "good1"
  ]);

  // The threshold moves the boundary rather than forbidding anything: at 5 only the T5 is "weak", so
  // the T4 falls back behind the unknown.
  assert.deepEqual(droppableFilters(filters, 5), [
    "weak5",
    "unknown",
    "weak4",
    "good2",
    "good1"
  ]);
});

test("an empty drop order means one rung and no relaxation at all", () => {
  // What `useModDropLadder: false` now produces. It used to fall through to the count ladder; there
  // is nothing left to fall through to, and that is the point.
  const filters = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const rungs = searchRungs(filters, [], { ratio: 0.5, maxDropSteps: 5 });

  assert.deepEqual(rungs.map((rung) => [rung.required, rung.filters.length]), [[4, 4]]);
  assert.deepEqual(rungs[0].dropped, []);
});

test("every rung requires all of its own filters, which is the whole design", () => {
  const filters = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
  const rungs = searchRungs(filters, ["e", "d"], { ratio: 0.5, maxDropSteps: 5 });

  // `required === filters.length` on every rung. Anything else is a count rung, and a count rung
  // cannot say which mods a price rests on — which is why they were removed.
  assert.ok(rungs.every((rung) => rung.required === rung.filters.length));
  assert.deepEqual(rungs.map((rung) => rung.filters.length), [5, 4, 3]);
  assert.deepEqual(rungs[1].dropped, ["e"]);
  assert.deepEqual(rungs[2].dropped, ["e", "d"]);
});

test("the survivor floor stops the ladder before it prices a base type wearing one mod", () => {
  const filters = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
  const order = ["e", "d", "c", "b", "a"];

  // Everything droppable and a cap far above what the floor allows: minSurvivingFilters(5, 0.5) = 3.
  assert.deepEqual(
    searchRungs(filters, order, { ratio: 0.5, maxDropSteps: 99 }).map((rung) => rung.filters.length),
    [5, 4, 3]
  );

  // A stricter ratio keeps more of the item, up to keeping all of it.
  assert.deepEqual(
    searchRungs(filters, order, { ratio: 0.9, maxDropSteps: 99 }).map((rung) => rung.filters.length),
    [5]
  );
});

test("the drop cap bounds the rungs independently of the floor", () => {
  const filters = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];

  assert.deepEqual(
    searchRungs(filters, ["e", "d", "c"], { ratio: 0.5, maxDropSteps: 1 }).map(
      (rung) => rung.filters.length
    ),
    [5, 4]
  );

  // 0 disables dropping as surely as the setting does.
  assert.deepEqual(
    searchRungs(filters, ["e"], { ratio: 0.5, maxDropSteps: 0 }).map((rung) => rung.filters.length),
    [5]
  );

  // One- and two-filter items have nothing to spare, so the floor alone yields no drops.
  assert.equal(searchRungs([{ id: "a" }, { id: "b" }], ["b"], { ratio: 0.5, maxDropSteps: 9 }).length, 1);
  assert.equal(searchRungs([{ id: "a" }], ["a"], { ratio: 0.5, maxDropSteps: 9 }).length, 1);
});

test("a tiered rare sheds its weakest mod and reports which one, so the editor can show it", async () => {
  // Nothing carries all five; the rung without the T5 rarity roll does. That set is knowable in a way
  // a `count` rung's never is, which is the whole reason the drop axis exists.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE_TIERED,
    new Set(),
    toChaos
  );

  assert.deepEqual(estimate.autoDroppedMods, ["15% increased Rarity of Items found"]);
  // The T1 life roll is exactly what a threshold relaxation might have let a listing miss instead.
  assert.ok(!estimate.autoDroppedMods.includes("+82 to maximum Life"));

  // The winning rung demanded all four survivors rather than "4 of 5" — a stricter, and knowable,
  // query. `filters` on the rungs is what tells those two apart.
  assert.deepEqual(estimate.rungs, [
    { required: 5, total: 0, filters: 5 },
    { required: 4, total: 3, filters: 4 }
  ]);

  const [stats] = JSON.parse(String(lastSearchCall(calls).init.body)).query.stats;
  assert.equal(stats.type, "and");
  assert.equal(demanded(stats), 4);
  // Sent, but disabled: the request carries all five so the trade site shows the whole mod table,
  // and the four enabled ones are the whole of what the group demands.
  assert.equal(stats.filters.length, 5);
  assert.equal(stats.filters.filter((filter: { disabled?: boolean }) => filter.disabled).length, 1);
});

test("an item whose mods carry no tier still drops, in the item's own order", async () => {
  // The no-Advanced-Item-Descriptions case, which is most players. It used to drop nothing and fall
  // through to the count ladder; with that gone, refusing to drop would strand every such rare on a
  // single all-mods rung, so unknown tiers relax in item order instead.
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.autoDroppedMods.length, 1, "one mod shed to reach the rung that matched");
  assert.equal(estimate.searchedMods.length, 4);
  // Still knowable, which is the point: the two lists partition the item's mods either way.
  assert.deepEqual(estimate.rungs, [
    { required: 5, total: 0, filters: 5 },
    { required: 4, total: 3, filters: 4 }
  ]);
});

test("the drop axis switched off means one rung and an unpriced item", async () => {
  // Nothing sits behind it any more, so off means "this item at these exact rolls, or no price". That
  // is a defensible choice — no number beats a number for a different item — but it is a choice, which
  // is why it stays a setting rather than becoming the default.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(
    makeSettings({ useModDropLadder: false }),
    fetch
  ).estimateRareValue(FIVE_MOD_RARE_TIERED, new Set(), toChaos);

  assert.deepEqual(estimate.autoDroppedMods, []);
  assert.equal(estimate.chaosValue, null);
  // One search, not two: there is no second rung to try. (`rungs` is empty on any unpriced estimate —
  // `noPrice` carries none — so the call count is what actually witnesses this.)
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
});

test("a mod the user already unticked is never reported as automatically dropped", async () => {
  // `ignoredMods` is filtered out before the filters are built, so the weakest *remaining* mod is
  // what goes. The two lists must stay disjoint or the editor can't tell whose decision was whose.
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE_TIERED,
    new Set(["15% increased Rarity of Items found"]),
    toChaos
  );

  assert.deepEqual(estimate.autoDroppedMods, ["+150 to Accuracy Rating"]);
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
  assert.equal(demanded(firstStatsGroup(searchCall(calls))), 5);
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

  assert.equal(estimate.chaosValue, 2);
  assert.equal(estimate.matchedMods, 3);
  assert.equal(estimate.totalMods, 5);

  const thresholds = calls
    .filter((call) => call.url.includes("/search/"))
    .map((call) => demanded(firstStatsGroup(call)));
  assert.deepEqual(thresholds, [5, 4, 3]);
});

test("one listing at a rung that dropped a mod isn't a market, so the ladder keeps loosening", async () => {
  // The real shape this guards: a Ruby jewel had one listing carrying four of its mods (at 30 chaos)
  // and eleven sharing three. Taking the single one would report a stranger's asking price as the
  // item's value — so `minListingsForMatch` governs any rung that shed something.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-lonely"], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.matchedMods, 3);
  assert.equal(estimate.matches, 3);
  // Only the winning rung is fetched, however many rungs were searched.
  assert.equal(calls.filter((call) => call.url.includes("/fetch/")).length, 1);
});

test("a strict rung that matched anything is never walked past, however high the threshold", async () => {
  // The rung that dropped nothing is the item itself, not a relaxation of it: those listings *are*
  // its comparables, so a looser rung would price a different item. The threshold here is 3 and the
  // strict rung has one listing — under the old rule the ladder shed a mod and priced off the rung
  // below, which is how a four-mod Sapphire with 9 exact listings came back priced on three.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [["id-lonely"], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.matchedMods, 5, "every mod, off the one rung that asked for them all");
  assert.equal(estimate.matches, 1);
  assert.deepEqual(estimate.autoDroppedMods, []);
  // And it costs one search, not the whole ladder.
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
});

test("the estimate carries the search id of the rung the price came from", async () => {
  // The point of the link is showing the listings the price was actually taken from. The rungs above
  // here were searched and passed over — one empty, one holding a single listing — so pointing at
  // either id would open a query that explains nothing about the number next to it.
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-lonely"], ["id-a", "id-b", "id-c"]],
    queryIds: ["query-strict", "query-thin", "query-priced"]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.searchId, "query-priced");
  assert.equal(
    tradeSearchUrl("Runes of Aldur", estimate.searchId),
    "https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/query-priced"
  );
});

test("a search that never priced anything offers no id to link to", async () => {
  // Nothing matched at any rung, so there is no query worth opening — and `tradeSearchUrl` turns the
  // absence into no link rather than a URL ending in "undefined".
  const { fetch } = stubFetch({ stats: STATS_5, searchIdsSequence: [[], [], []] });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, null);
  assert.equal(estimate.searchId, undefined);
  assert.equal(tradeSearchUrl("Runes of Aldur", estimate.searchId), null);
});

test("the ladder reports what each rung matched, so a passed-over rung can be explained", async () => {
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-lonely"], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  // "one listing carries four of the five mods" and "none carries all five" are different things to
  // tell the user. `required` tracks `filters` down the ladder — each rung dropped a mod and demanded
  // all of the rest, rather than asking for any N of five.
  assert.deepEqual(estimate.rungs, [
    { required: 5, total: 0, filters: 5 },
    { required: 4, total: 1, filters: 4 },
    { required: 3, total: 3, filters: 3 }
  ]);
});

test("at the shipped default the ladder stops on the first rung that matched anything", async () => {
  // minListingsForMatch: 1 is the default, and it means specificity over sample depth: the 3-listing
  // rung is the most specific comparison this item has, so the ladder must take it and not descend to
  // the deeper, looser one below. The real capture behind this priced a 4-mod tablet off 2 of its
  // mods because a 3-listing rung was passed over.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"], ["id-d", "id-e", "id-f", "id-g"]]
  });
  const estimate = await new Trade2Client(
    makeSettings({ minListingsForMatch: 1 }),
    fetch
  ).estimateRareValue(FIVE_MOD_RARE, new Set(), toChaos);

  // Two rungs sent, not three — the loosest was never requested.
  assert.deepEqual(estimate.rungs, [
    { required: 5, total: 0, filters: 5 },
    { required: 4, total: 3, filters: 4 }
  ]);
  assert.equal(estimate.matchedMods, 4);
  assert.equal(estimate.matches, 3);
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 2);

  // The price comes from that same rung: the cheapest of the listings it fetched.
  assert.ok(estimate.chaosValue !== null);
});

test("an empty rung is not a hit, even at a threshold of 1", async () => {
  // 0 >= 1 is false, so a rung that matched nothing can never stop the ladder — otherwise the first
  // search would always win and the ladder would never descend at all.
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], [], ["id-a", "id-b"]]
  });
  const estimate = await new Trade2Client(
    makeSettings({ minListingsForMatch: 1 }),
    fetch
  ).estimateRareValue(FIVE_MOD_RARE, new Set(), toChaos);

  assert.equal(estimate.matchedMods, 3);
  assert.equal(estimate.matches, 2);
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
  assert.equal(estimate.chaosValue, 2);
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
  assert.match(estimate.reason!, /as few as 3 of its 5 mods/);
  // One number per rung, since every rung requires all of what it sends: five mods, then four, then
  // three, stopping at the survivor floor rather than descending to a threshold.
  assert.match(estimate.reason!, /tried 5, 4, 3 mods/);
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
  // The looser rungs that would have priced this were never sent, so the row must not claim the
  // market has nothing — it hasn't been asked yet.
  assert.equal(estimate.failure, "rateLimited");
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

  assert.match(
    estimate.reason!,
    /no in-person listings from online sellers for base type "Sapphire Ring"/
  );
});

test("a 429 is reported as a rate limit, naming the setting that controls it", async () => {
  const { fetch } = stubFetch({ searchStatus: 429, retryAfter: "60" });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, null);
  assert.equal(estimate.listingIndexedAt, undefined, "no price means no listing to date either");
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

  assert.equal(estimate.chaosValue, 2);
  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 2);
});

test("a dropped socket is retried too", async () => {
  const { fetch } = stubFetch({ throwOnSearch: 1 });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, 2);
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

test("the cheapest listing's own quote rides along, for the unit the row is shown in", async () => {
  // Listed out of order on purpose: the quote has to follow the *cheapest* converted value through
  // the sort, not the first entry GGG happened to return.
  const { fetch } = stubFetch({
    listings: [
      { amount: 5, currency: "exalted" },
      { amount: 1, currency: "divine" },
      { amount: 2, currency: "exalted" }
    ]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  // 2 exalted converts to 4 chaos here, the cheapest of the three.
  assert.equal(estimate.chaosValue, 4);
  // Exactly two fields: GGG's price object also carries a `type` ("~b/o"), and this is persisted.
  assert.deepEqual(estimate.listingQuote, { amount: 2, currency: "exalted" });
  assert.deepEqual(Object.keys(estimate.listingQuote!).sort(), ["amount", "currency"]);
});

test("the listing date comes from the cheapest listing, not GGG's first", async () => {
  // Same argument as the quote beside it: the row annotates one number, so the date has to describe
  // the listing that number came from. Taking entry [0] would date this price to a seller whose
  // asking price was never used.
  const { fetch } = stubFetch({
    listings: [
      { amount: 5, currency: "exalted" },
      { amount: 1, currency: "divine" },
      { amount: 2, currency: "exalted" }
    ],
    indexedSequence: [
      "2026-08-01T10:00:00Z",
      "2026-08-10T10:00:00Z",
      "2026-08-18T10:00:00Z"
    ]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, 4, "the 2-exalted listing is the cheapest");
  assert.equal(estimate.listingIndexedAt, Date.parse("2026-08-18T10:00:00Z"));
});

test("a response with no dates prices normally and carries none", async () => {
  // The case every existing capture is in, and the case a GGG response without the field would be
  // in. Neither may cost the price — the date is an annotation, not a precondition.
  const { fetch } = stubFetch();
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, 2);
  assert.equal(estimate.listingIndexedAt, undefined);
});

test("a date that won't parse is dropped rather than stored as NaN", async () => {
  // `Date.parse` returns NaN instead of throwing, and NaN reaching the row would render "(listed
  // NaN)" — worse than the nothing an absent date produces.
  const { fetch } = stubFetch({
    listings: [{ amount: 5, currency: "exalted" }],
    indexedSequence: ["not a date at all"]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, 10, "an unusable date must not cost the price");
  assert.equal(estimate.listingIndexedAt, undefined);
});

test("a listing this app can't convert never dates the price either", async () => {
  // Dropped before the sort with its quote, so a listing that can't price the item can't date it.
  const { fetch } = stubFetch({
    listings: [{ amount: 3, currency: "some-unknown-orb" }, { amount: 5, currency: "exalted" }],
    indexedSequence: ["2026-08-01T10:00:00Z", "2026-08-18T10:00:00Z"]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, 10);
  assert.equal(estimate.listingIndexedAt, Date.parse("2026-08-18T10:00:00Z"));
});

test("a listing this app can't convert never becomes the quote either", async () => {
  // It is dropped before the sort, so it can neither price the item nor label it.
  const { fetch } = stubFetch({
    listings: [{ amount: 3, currency: "some-unknown-orb" }, { amount: 5, currency: "exalted" }]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(estimate.chaosValue, 10);
  assert.deepEqual(estimate.listingQuote, { amount: 5, currency: "exalted" });
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

  assert.equal((await client.estimateRareValue(RARE, new Set(), toChaos)).chaosValue, 2);
  assert.equal((await client.estimateRareValue(RARE, new Set(), toChaos)).chaosValue, 2);

  const third = await client.estimateRareValue(RARE, new Set(), toChaos);
  assert.equal(third.chaosValue, null);
  assert.match(third.reason!, /budget spent/);
  assert.match(third.reason!, /Reprice/, "the message must name the way to retry");
  assert.equal(third.failure, "rateLimited");
});

test("cooldownMs is 0 while budget remains and positive once it is spent", async () => {
  // The panel's countdown reads this through `Trade2Client` rather than reaching into the budget,
  // which stays private. 0 covers both "budget free" and "nothing reserved yet" — the same thing to
  // a caller, and what the status field turns into null.
  const { fetch } = stubFetch();
  const client = new Trade2Client(makeSettings({ maxSearchesPerWindow: 2 }), fetch);

  assert.equal(client.cooldownMs(), 0, "nothing reserved yet");

  await client.estimateRareValue(RARE, new Set(), toChaos);
  await client.estimateRareValue(RARE, new Set(), toChaos);
  const declined = await client.estimateRareValue(RARE, new Set(), toChaos);

  assert.equal(declined.failure, "rateLimited");
  // The row would otherwise have nothing live to count down to; the "retry in ~Ns" inside `reason`
  // is frozen at the moment that sentence was built.
  assert.ok(client.cooldownMs() > 0, "a spent budget has to report a wait the panel can show");
  assert.ok(
    client.cooldownMs() <= makeSettings().trade2.windowMs,
    "and never one longer than the window it is waiting on"
  );
});

test("the failure kind separates 'nobody looked' from 'nothing matches'", async () => {
  // The distinction the field exists for. A search that went out and found an empty market is a fact
  // about the item and waiting changes nothing; a declined one expires on its own. Both store no
  // price, so `reason` — user-facing prose that gets reworded — is the only other thing telling them
  // apart, which is exactly why the caller shouldn't have to read it.
  const { fetch } = stubFetch({ stats: STATS_RES, searchIds: [] });
  const empty = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );
  assert.equal(empty.chaosValue, null);
  assert.equal(empty.failure, "noListings");

  const priced = await new Trade2Client(makeSettings(), stubFetch().fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );
  assert.equal(priced.failure, null, "a priced item has no failure kind at all");
});

test("a 429 is reported as rate-limited, not as an empty market", async () => {
  // GGG answering 429 means the budget is set too high for this IP — the item was never looked at.
  const { fetch } = stubFetch({ searchStatus: 429 });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, null);
  assert.match(estimate.reason!, /HTTP 429/);
  assert.equal(estimate.failure, "rateLimited");
});

// ---------------------------------------------------------------------------
// searchedMods: which mods the winning query actually asked for
// ---------------------------------------------------------------------------

const sortedTexts = (texts: readonly string[]): string[] => [...texts].sort();

test("every mod the winning query asked for is reported, so the editor ticks exactly those", async () => {
  const { fetch } = stubFetch({ stats: STATS_5 });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.deepEqual(
    sortedTexts(estimate.searchedMods),
    sortedTexts([
      "+82 to maximum Life",
      "12% increased Attack Speed",
      "9% increased Cast Speed",
      "+150 to Accuracy Rating",
      "15% increased Rarity of Items found"
    ])
  );
  assert.deepEqual(estimate.autoDroppedMods, []);
});

test("a mod GGG indexes nothing for is left out, which is the case the ticks exist for", async () => {
  // STATS_5 carries no cold resistance template, so that line reaches no filter group at all. It is
  // neither the user's exclusion nor the ladder's drop, and before this it still opened ticked —
  // reading as a mod the price rested on when the query never mentioned it.
  const { fetch } = stubFetch({ stats: STATS_5 });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  assert.deepEqual(estimate.searchedMods, ["+80 to maximum Life"]);
});

test("the drop axis partitions the matched mods, with nothing falling between the two lists", async () => {
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE_TIERED,
    new Set(),
    toChaos
  );

  assert.deepEqual(estimate.autoDroppedMods, ["15% increased Rarity of Items found"]);
  assert.deepEqual(
    sortedTexts(estimate.searchedMods),
    sortedTexts([
      "+82 to maximum Life",
      "12% increased Attack Speed",
      "9% increased Cast Speed",
      "+150 to Accuracy Rating"
    ])
  );

  // The invariant the editor's ticks rest on: every mod that produced a filter lands in exactly one
  // of the two lists. One in neither would open unticked and badged "not searched", which would be a
  // lie about a mod the search did send.
  assert.deepEqual(
    sortedTexts([...estimate.searchedMods, ...estimate.autoDroppedMods]),
    sortedTexts([
      "+82 to maximum Life",
      "12% increased Attack Speed",
      "9% increased Cast Speed",
      "+150 to Accuracy Rating",
      "15% increased Rarity of Items found"
    ])
  );
});

test("resistance rolls folded into an applied aggregate still count as searched", async () => {
  const { fetch } = stubFetch({ stats: STATS_RES });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RES_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.pseudoDropped, false);
  // They are not their own stat filters — that is the point of the aggregate — but the 83% total
  // they add up to is in the query, so unticking them would deny rolls the search did ask for.
  for (const text of [
    "+38% to Cold Resistance",
    "+25% to Fire Resistance",
    "+20% to Lightning Resistance"
  ]) {
    assert.ok(estimate.searchedMods.includes(text), text);
  }
  assert.ok(estimate.searchedMods.includes("+82 to maximum Life"));
});

test("an aggregate the search had to drop takes its contributors out of the searched set", async () => {
  const { fetch } = stubFetch({
    stats: STATS_RES,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    RES_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.pseudoDropped, true);
  // The retry sent neither the aggregate nor the three rolls individually — they were folded out
  // before the ladder was built — so nothing about this item's resistances constrained the price.
  assert.deepEqual(
    sortedTexts(estimate.searchedMods),
    sortedTexts(["+82 to maximum Life", "15% increased Rarity of Items found"])
  );
});

test("local defence mods count as searched, since the armour floor is what carries them", async () => {
  const { fetch } = stubFetch({ stats: STATS_ARMOUR });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    ARMOUR_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.defencesDropped, false);
  assert.deepEqual(
    sortedTexts(estimate.searchedMods),
    sortedTexts([
      "+186 to Armour",
      "38% increased Armour",
      "+32 to maximum Mana",
      "+80 to maximum Life"
    ])
  );
});

test("dropping the defence floors drops the mods that were folded into them", async () => {
  const { fetch } = stubFetch({
    stats: STATS_ARMOUR,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    ARMOUR_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.defencesDropped, true);
  assert.deepEqual(
    sortedTexts(estimate.searchedMods),
    sortedTexts(["+32 to maximum Mana", "+80 to maximum Life"])
  );
});

test("a waystone reports no searched mods, because its affixes are never sent as filters", async () => {
  const { fetch } = stubFetch({ stats: STATS_RES });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    WAYSTONE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, 2);
  assert.deepEqual(estimate.searchedMods, []);
});

test("an estimate with no price reports no searched mods rather than a stale set", async () => {
  const { fetch } = stubFetch({ stats: STATS_5, searchIdsSequence: NO_LISTINGS });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, null);
  assert.deepEqual(estimate.searchedMods, []);
});

// ---------------------------------------------------------------------------
// Base items: searched on item level, and gated on it too
// ---------------------------------------------------------------------------

/** The reported capture: a white base that fell through every source and stored unpriced. */
const BASE_ITEM = parse(
  "Item Class: Foci\nRarity: Normal\nSacred Focus\n--------\nEnergy Shield: 152\n--------\n" +
    "Requires: Level 78, 160 Int\n--------\nItem Level: 82"
);

const baseAt = (level: number): ParsedItem =>
  parse(
    "Item Class: Foci\nRarity: Normal\nSacred Focus\n--------\nEnergy Shield: 152\n--------\n" +
      `Item Level: ${level}`
  );

test("a white base is searched on its item level, at its own level exactly", async () => {
  const { fetch, calls } = stubFetch();
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    BASE_ITEM,
    new Set(),
    toChaos
  );

  const { query } = JSON.parse(String(searchCall(calls).init.body));
  assert.equal(query.type, "Sacred Focus");
  // No ratio beneath it, unlike every other floor this sends. Item level is a breakpoint, not a
  // continuous stat: 0.9 of 82 is 73, which is a different market rather than a wider one.
  assert.deepEqual(query.filters.misc_filters.filters.ilvl, { min: 82 });
  assert.equal(estimate.chaosValue, 2);
});

test("a white base asks for normal rarity, or it prices off the rares on its own base", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(BASE_ITEM, new Set(), toChaos);

  const { query } = JSON.parse(String(searchCall(calls).init.body));
  assert.deepEqual(query.filters.type_filters.filters.rarity, { option: "normal" });
});

test("a corrupted white base sends ilvl and corrupted, not one instead of the other", async () => {
  // Both are misc filters, so that group has to accumulate — assigning it twice drops the first.
  const corrupted = parse(
    "Item Class: Foci\nRarity: Normal\nSacred Focus\n--------\nEnergy Shield: 152\n--------\n" +
      "Item Level: 82\n--------\nCorrupted"
  );
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(corrupted, new Set(), toChaos);

  assert.deepEqual(
    JSON.parse(String(searchCall(calls).init.body)).query.filters.misc_filters.filters,
    { corrupted: { option: "true" }, ilvl: { min: 82 } }
  );
});

test("a white base sends no defence floors, since its base type already pins them", async () => {
  // It has no affixes for a floor to be measuring, and the printed value moves with quality — so a
  // floor taken off a 20% one silently excludes every 0% listing of the identical base.
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(BASE_ITEM, new Set(), toChaos);

  assert.equal(
    JSON.parse(String(searchCall(calls).init.body)).query.filters.equipment_filters,
    undefined
  );
});

test("a base below the item level floor costs no request at all", async () => {
  const { fetch, calls } = stubFetch();
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    baseAt(65),
    new Set(),
    toChaos
  );

  assert.equal(calls.length, 0, "the whole point is that white drops don't spend the budget");
  assert.equal(estimate.chaosValue, null);
  assert.match(estimate.reason!, /baseItemMinLevel/);
});

test("the floor is a setting, so a lower one lets the same base through", async () => {
  const { fetch, calls } = stubFetch();
  const estimate = await new Trade2Client(
    makeSettings({ baseItemMinLevel: 60 }),
    fetch
  ).estimateRareValue(baseAt(65), new Set(), toChaos);

  assert.ok(calls.length > 0);
  assert.equal(estimate.chaosValue, 2);
});

test("base item search can be switched off entirely", async () => {
  const { fetch, calls } = stubFetch();
  const estimate = await new Trade2Client(
    makeSettings({ useBaseItemSearch: false }),
    fetch
  ).estimateRareValue(BASE_ITEM, new Set(), toChaos);

  assert.equal(calls.length, 0);
  assert.match(estimate.reason!, /useBaseItemSearch/);
});

test("a rare is untouched by the base item gate, however low its level", async () => {
  const lowRare = parse(
    "Item Class: Rings\nRarity: Rare\nApocalypse Core\nSapphire Ring\n--------\nItem Level: 12\n" +
      "--------\n+80 to maximum Life"
  );
  const { fetch, calls } = stubFetch();
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    lowRare,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, 2);
  const { query } = JSON.parse(String(searchCall(calls).init.body));
  assert.equal(query.filters?.type_filters, undefined, "rarity is only pinned for a white base");
});

// ---------------------------------------------------------------------------
// The dropped mods ride along disabled, so the search link shows the whole table
// ---------------------------------------------------------------------------

const statGroup = (calls: Call[]) =>
  JSON.parse(String(lastSearchCall(calls).init.body)).query.stats[0] as {
    type: string;
    value?: { min: number };
    filters: Array<{ id: string; disabled?: boolean }>;
  };

test("a dropped mod is sent disabled rather than removed, and does not count toward the min", async () => {
  // The point of the "View search" link: opening a price should show every mod GGG indexes, with the
  // ones the query used ticked and the rest visibly not. Confirmed live that GGG ignores a disabled
  // filter when matching, so this widens nothing.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE_TIERED,
    new Set(),
    toChaos
  );

  const group = statGroup(calls);
  assert.equal(group.filters.length, 5, "all five are sent so the trade site can show them");
  assert.equal(demanded(group), 4, "but only the four enabled ones are demanded");
  assert.equal(group.filters.filter((filter) => filter.disabled).length, 1);
  // Enabled entries carry no flag at all rather than `disabled: false`, matching how `value` behaves.
  assert.ok(group.filters.filter((filter) => !filter.disabled).every((filter) => !("disabled" in filter)));
});

test("the strictest rung sends nothing disabled, because it dropped nothing", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_5 });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE_TIERED,
    new Set(),
    toChaos
  );

  const group = statGroup(calls);
  assert.equal(group.filters.length, 5);
  assert.equal(demanded(group), 5);
  assert.equal(group.filters.filter((filter) => filter.disabled).length, 0);
});

test("every rung demands all of its enabled filters — no rung ever asks for fewer", async () => {
  // The assertion that fails first if count relaxation is ever reintroduced. Every rung must be an
  // `and` over its enabled filters; a `count` with a lower `min` is "any N of M", which cannot say
  // which mods a price rests on.
  const { fetch, calls } = stubFetch({ stats: STATS_5, searchIdsSequence: [[], [], []] });
  await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE_TIERED,
    new Set(),
    toChaos
  );

  const searches = calls.filter((call) => call.url.includes("/search/"));
  assert.equal(searches.length, 3, "five mods, floor of three: three rungs");
  for (const call of searches) {
    const group = firstStatsGroup(call);
    assert.equal(group.type, "and");
    assert.equal((group as { value?: unknown }).value, undefined);
    assert.equal(group.filters.length, 5, "the full table travels on every rung");
  }
});

test("the survivor floor bounds a live lookup, not just the pure function", async () => {
  // minModMatchRatio 0.5 over five mods floors at three, so the ladder stops there however generous
  // the drop cap is — it never reaches the one-mod query that is a base-type search in disguise.
  const { fetch, calls } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], [], [], [], []]
  });
  await new Trade2Client(
    makeSettings({ maxModDropSearches: 99 }),
    fetch
  ).estimateRareValue(FIVE_MOD_RARE_TIERED, new Set(), toChaos);

  const mins = calls
    .filter((call) => call.url.includes("/search/"))
    .map((call) => demanded(firstStatsGroup(call)));
  assert.deepEqual(mins, [5, 4, 3]);
});

test("a stricter ratio keeps the whole item, and leaves it unpriced rather than approximate", async () => {
  const { fetch, calls } = stubFetch({ stats: STATS_5, searchIdsSequence: [[], [], []] });
  const estimate = await new Trade2Client(
    makeSettings({ minModMatchRatio: 1 }),
    fetch
  ).estimateRareValue(FIVE_MOD_RARE_TIERED, new Set(), toChaos);

  assert.equal(calls.filter((call) => call.url.includes("/search/")).length, 1);
  assert.equal(estimate.chaosValue, null);
});

test("what was dropped and what was searched still partition the item's mods", async () => {
  // The disabled filters must not leak into `searchedMods` — they are sent, but they asked for
  // nothing, so crediting the price to them would be exactly the overstatement this all exists to fix.
  const { fetch } = stubFetch({
    stats: STATS_5,
    searchIdsSequence: [[], ["id-a", "id-b", "id-c"]]
  });
  const estimate = await new Trade2Client(makeSettings(), fetch).estimateRareValue(
    FIVE_MOD_RARE_TIERED,
    new Set(),
    toChaos
  );

  assert.deepEqual(estimate.autoDroppedMods, ["15% increased Rarity of Items found"]);
  assert.equal(estimate.searchedMods.length, 4);
  assert.ok(!estimate.searchedMods.includes("15% increased Rarity of Items found"));
});

// ---------------------------------------------------------------------------
// The minimum listing price, applied to the search rather than the sample
// ---------------------------------------------------------------------------

const tradeFiltersOf = (calls: Call[]) =>
  JSON.parse(String(searchCall(calls).init.body)).query.filters?.trade_filters?.filters;

test("the price floor is sent to GGG, not applied to the fetched sample", async () => {
  // It has to constrain the search: `priceSample` takes the ten *cheapest* matches, so a floor
  // applied after the fetch would find every one of them below it and leave nothing to price.
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings({ minListingPrice: 1 }), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  // No `option`, ever. It names the currency a listing is *quoted in* rather than a unit to compare
  // against, so `{ min: 1, option: "exalted" }` asked for listings priced in exalted orbs and threw
  // away every divine-priced one. Measured on a real jewel query whose two matches were quoted in
  // divine: 0 results with the option, 2 without it.
  assert.deepEqual(tradeFiltersOf(calls).price, { min: 1 });
});

test("the floor rides alongside the sale type rather than replacing it", async () => {
  // Both are trade filters under one key, so the group has to accumulate — the same mistake the
  // misc_filters group already guards against.
  const { fetch, calls } = stubFetch();
  await new Trade2Client(
    makeSettings({ saleType: "any", minListingPrice: 2 }),
    fetch
  ).estimateRareValue(RARE, new Set(), toChaos);

  assert.deepEqual(tradeFiltersOf(calls), {
    sale_type: { option: "any" },
    price: { min: 2 }
  });
});

test("a floor of 0 sends nothing, so the query is exactly what it was before", async () => {
  const { fetch, calls } = stubFetch();
  await new Trade2Client(makeSettings({ minListingPrice: 0 }), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  assert.equal(JSON.parse(String(searchCall(calls).init.body)).query.filters, undefined);
});

test("an item with nothing at or above the floor is unpriced, and the reason names the floor", async () => {
  // No retry without it, unlike the defence and aggregate floors: those widen a search that was too
  // specific, while this one rejects a market not worth recording. Retrying would hand back exactly
  // the sub-floor number the setting exists to suppress.
  const { fetch, calls } = stubFetch({ searchIdsSequence: NO_LISTINGS });
  const estimate = await new Trade2Client(makeSettings({ minListingPrice: 1 }), fetch).estimateRareValue(
    RARE,
    new Set(),
    toChaos
  );

  assert.equal(estimate.chaosValue, null);
  assert.match(estimate.reason!, /priced at or above 1/);
  // Every rung carried the floor; none of them was retried without it.
  for (const call of calls.filter((entry) => entry.url.includes("/search/"))) {
    const filters = JSON.parse(String(call.init.body)).query.filters?.trade_filters?.filters;
    assert.deepEqual(filters.price, { min: 1 });
  }
});

test("the floor is named in the log line too, so a rung's count is readable", async () => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => void lines.push(String(line));
  try {
    const { fetch } = stubFetch();
    await new Trade2Client(makeSettings({ minListingPrice: 1 }), fetch).estimateRareValue(
      RARE,
      new Set(),
      toChaos
    );
  } finally {
    console.log = log;
  }

  assert.ok(
    lines.some((line) => line.includes("priced at or above 1") && line.includes("listing(s)")),
    `expected a rung line naming the floor, got:\n${lines.join("\n")}`
  );
});
