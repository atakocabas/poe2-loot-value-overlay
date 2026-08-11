/**
 * Checks src/pricing/exchange-metadata-ids.ts against live data.
 *
 * A metadata id can only be confirmed empirically: the Currency Exchange feed publishes no names,
 * so the way to tell whether "vaal orb" -> CurrencyCorrupt is right is to price that id off the
 * exchange and see whether it agrees with poe.ninja's price for Vaal Orb. Large disagreement means
 * the mapping is almost certainly wrong.
 *
 * This is necessary but not sufficient — hundreds of items sit within 10% of each other, so
 * agreement is weak evidence while *dis*agreement is strong evidence. Treat a FAIL as a bug and a
 * PASS as "not obviously broken".
 *
 * Run against compiled output so it exercises the real client:
 *   npm run verify:exchange-ids
 */
const { buildChaosIndex } = require("../dist/pricing/currency-exchange-client");
const { allMappedIds } = require("../dist/pricing/exchange-metadata-ids");
const defaults = require("../config/settings.default.json");

const LEAGUE = process.argv[2] || defaults.league;
const { baseUrl, realm, lookbackHours, maxPagesPerRefresh, minVolume } = defaults.currencyExchange;
const HOUR = 3600;

async function fetchMarkets() {
  let hourId = Math.floor(Date.now() / 1000 / HOUR) * HOUR - lookbackHours * HOUR;
  const markets = [];

  for (let page = 0; page < maxPagesPerRefresh; page++) {
    const response = await fetch(`${baseUrl}/${realm}/${hourId}`, { headers: { accept: "application/json" } });
    if (!response.ok) {
      console.error(`hour ${hourId}: HTTP ${response.status}`);
      break;
    }
    const body = await response.json();
    if (body.markets) markets.push(...body.markets);
    if (!body.next_change_id || body.next_change_id === hourId) break;
    hourId = body.next_change_id;
  }
  return markets;
}

async function fetchPoeNinjaChaosByName() {
  const byName = new Map();
  for (const type of defaults.poeNinja.exchangeOverviewTypes) {
    const url = `${defaults.poeNinja.baseUrl}/exchange/current/overview?league=${encodeURIComponent(LEAGUE)}&type=${type}`;
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) continue;

    const body = await response.json();
    const chaosPerDivine = body.core && body.core.rates && body.core.rates.chaos;
    if (!chaosPerDivine || !body.lines) continue;

    // core.items only describes the rate currencies; the top-level items array carries the names.
    const nameById = new Map([...(body.core.items || []), ...(body.items || [])].map((i) => [i.id, i.name]));
    for (const line of body.lines) {
      const name = nameById.get(line.id);
      if (name) byName.set(name.toLowerCase(), line.primaryValue * chaosPerDivine);
    }
  }
  return byName;
}

(async () => {
  const markets = await fetchMarkets();
  const index = buildChaosIndex(markets, { league: LEAGUE, minVolume });
  const ninja = await fetchPoeNinjaChaosByName();

  console.log(`league "${LEAGUE}": ${markets.length} markets fetched, ${index.entries.size} ids priced`);
  console.log(`chaos/divine ${index.chaosPerDivine?.toFixed(3)}, chaos/exalted ${index.chaosPerExalted?.toFixed(5)}`);
  console.log(`poe.ninja: ${ninja.size} named prices\n`);

  const rows = [];
  let failures = 0;
  for (const { name, metadataId } of allMappedIds()) {
    const mine = index.entries.get(metadataId);
    const theirs = ninja.get(name);
    let verdict;

    if (!mine) verdict = "not traded";
    else if (theirs === undefined) verdict = "no poe.ninja price";
    else {
      const ratio = mine.chaosValue / theirs;
      // Log-space so the tolerance is symmetric: 2x too high and 2x too low are equally bad.
      const off = Math.abs(Math.log(ratio));
      const absolute = Math.abs(mine.chaosValue - theirs);

      // Both tests must fail before this counts as a mismatch. Items worth a fraction of an
      // exalted routinely disagree by 2-3x between the two sources — they're bulk-traded, the
      // exchange quotes them as integer ratios, and neither source is really "wrong" — while the
      // absolute error stays under a hundredth of a chaos and cannot move a session total. A
      // genuinely mismapped id points at an unrelated item and blows both budgets at once.
      const wrong = off >= 0.25 && absolute >= 0.05;
      verdict = wrong ? `MISMATCH x${ratio.toFixed(2)}` : off < 0.25 ? "ok" : `noisy x${ratio.toFixed(2)}`;
      if (wrong) failures++;
    }

    rows.push({
      name,
      id: metadataId.replace("Metadata/Items/", ""),
      exchange: mine ? Number(mine.chaosValue.toFixed(4)) : null,
      poeNinja: theirs === undefined ? null : Number(theirs.toFixed(4)),
      delta: mine && theirs !== undefined ? Number((mine.chaosValue - theirs).toFixed(4)) : null,
      verdict
    });
  }
  console.table(rows);

  const unmapped = [...index.entries.entries()]
    .filter(([id]) => !allMappedIds().some((m) => m.metadataId === id))
    .sort((a, b) => b[1].volume - a[1].volume)
    .slice(0, 20)
    .map(([id, e]) => ({ id: id.replace("Metadata/Items/", ""), volume: e.volume, chaos: Number(e.chaosValue.toFixed(4)) }));

  console.log("\nHighest-volume ids with no table entry — candidates to map next:");
  console.table(unmapped);

  console.log(failures === 0 ? "\nNo mismatches." : `\n${failures} mismatch(es) — fix or remove those entries.`);
  process.exit(failures === 0 ? 0 : 1);
})();
