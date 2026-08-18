/**
 * Turns a trade2 search id into the URL for that same search on the trade site.
 *
 * The id comes back from `POST /api/trade2/search/poe2/{league}` and is what `Trade2Client` already
 * passes to the fetch endpoint as `?query=`. The site takes the same id as the last path segment, so
 * a price this app produced can be opened as the exact query it was taken from — which is the only
 * honest way to answer "where did that number come from".
 *
 * **The id is not permanent.** GGG expires searches, so a link saved with a drop from an hour ago may
 * well 404 by the time anyone clicks it. That is a property of the id, not a bug here: this function
 * builds a URL, and whether the search behind it still exists is between the user and the trade site.
 */

const TRADE_SITE = "https://www.pathofexile.com/trade2/search";

/** Same realm segment `Trade2Client` sends; the site takes it in the path exactly as the API does. */
const REALM = "poe2";

/**
 * Null rather than a broken URL when either half is missing — an item priced off poe.ninja or the
 * currency exchange never had a trade search, and a link to nowhere is worse than no link.
 *
 * Both halves are encoded: league names carry spaces ("Rise of the Abyssal"), and while search ids
 * have only ever been alphanumeric, encoding one costs nothing and assumes nothing.
 */
export function tradeSearchUrl(league: string, searchId: string | null | undefined): string | null {
  if (!league || !searchId) return null;
  return `${TRADE_SITE}/${REALM}/${encodeURIComponent(league)}/${encodeURIComponent(searchId)}`;
}
