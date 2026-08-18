import assert from "node:assert/strict";
import { test } from "node:test";
import { tradeSearchUrl } from "../shared/trade-link";

test("builds the trade site's URL for a search the app ran", () => {
  // The shape the site takes: realm, league, then the id GGG handed back from POST /search.
  assert.equal(
    tradeSearchUrl("Rise of the Abyssal", "d2kZWbXfE"),
    "https://www.pathofexile.com/trade2/search/poe2/Rise%20of%20the%20Abyssal/d2kZWbXfE"
  );
});

test("encodes the league rather than pasting spaces into a URL", () => {
  // Every PoE2 league name so far has had spaces in it, so this is the ordinary case, not an edge.
  const url = tradeSearchUrl("Runes of Aldur", "abc123");
  assert.ok(!url?.includes(" "), `a raw space would break the link: ${url}`);
  assert.match(String(url), /\/poe2\/Runes%20of%20Aldur\/abc123$/);
});

test("a hardcore or event league is just another name, not a different path", () => {
  // The realm segment is poe2 regardless — the league is the only thing that varies.
  assert.equal(
    tradeSearchUrl("HC Rise of the Abyssal", "xY9"),
    "https://www.pathofexile.com/trade2/search/poe2/HC%20Rise%20of%20the%20Abyssal/xY9"
  );
});

test("no search id means no link", () => {
  // Items priced off poe.ninja or the currency exchange never ran a trade search, and neither did a
  // rare whose every rung came back empty. A URL ending in "undefined" would look like a real link.
  assert.equal(tradeSearchUrl("Runes of Aldur", undefined), null);
  assert.equal(tradeSearchUrl("Runes of Aldur", null), null);
  assert.equal(tradeSearchUrl("Runes of Aldur", ""), null);
});

test("no league means no link either", () => {
  // The league is blank only before first-run setup has been completed, when nothing has been priced
  // anyway — but a URL with an empty path segment is a 404 dressed up as a link.
  assert.equal(tradeSearchUrl("", "d2kZWbXfE"), null);
});
