# PoE2 Loot Value Overlay

A Windows overlay for Path of Exile 2 that prices loot you've picked up during a map and lets you
review the total afterward.

This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

## Install

Windows only. Grab either download from the
[Releases page](https://github.com/atakocabas/poe2-loot-value-overlay/releases):

- **`PoE2 Loot Value Overlay Setup <version>.exe`** — the installer. Lets you choose an install
  directory and adds a Start Menu entry.
- **`PoE2 Loot Value Overlay <version>.exe`** — portable. Run it where it sits; nothing is
  installed. Settings and the loot cache still live in `%APPDATA%/poe2-loot-value-overlay/`, which
  both downloads share.

Neither is code-signed, so Windows SmartScreen warns before it runs — *More info* → *Run anyway*.
Expect that on **every** release, not just the first: SmartScreen tracks reputation per exact file,
so a new version is a file it has never seen, and an unsigned one carries nothing over from the last.
If you'd rather not trust a binary, `npm run package` (see [Development](#development)) builds exactly
these two files from this source.

### Updates

The app asks GitHub for the latest release when it starts and every six hours after that. If one is
newer than what you're running, it says so in two places: an **Update available: vX.Y.Z** entry at
the top of the tray menu, and a line in the panel header once you've opened the full list. Either one
opens that release's page.

**It never downloads or installs anything.** Updating means fetching the new exe from that page
yourself, exactly as you did the first time — which is also why the portable download is no worse off
than the installed one here. Set `updates.checkForUpdates` to `false` in
`%APPDATA%/poe2-loot-value-overlay/settings.json` to switch the check off entirely; there is no
setting for it in the settings window.

## First run

The app asks for two things once, in a small setup window, because neither can ship as a
working default. You can reopen it any time from the tray icon's **Setup…**.

- **League** — every price source is queried per league, and leagues rotate every few months. A name
  that doesn't match the one you're playing isn't an error anywhere; it just leaves everything
  unpriced.
- **Contact email** *(optional)* — sent to GGG in the `User-Agent` when pricing rares, so they can
  reach the person whose machine is making the requests. Blank sends no contact address at all.

Saving from the tray restarts the app: the league is read at startup by three separate pricing
clients, and half-applying it would be worse than a restart.

## What it reads, and why that's within GGG's API policy

GGG's [developer API policy](https://www.pathofexile.com/developer/docs) sorts third-party apps
into categories. This app is an "executable app that runs independently from the game," which is
permitted subject to a few rules — here's how each piece of this app satisfies them:

- **Item pricing (just Ctrl+C on an item, nothing app-specific to press)**: PoE2 already copies
  the hovered item's text to the clipboard on Ctrl+C — a native game function. The app passively
  watches the clipboard for changes (polling, no hotkey) and reacts whenever new text looks like
  an item. It deliberately does *not* register Ctrl+C as a global hotkey — Electron's
  `globalShortcut` intercepts a key combo system-wide, which would stop PoE2 (the focused window)
  from ever receiving the keystroke and copying the item in the first place. The policy's macro
  rules govern automating keystrokes *into* the game, which doesn't apply here — nothing is
  simulated toward PoE2, ever. See [clipboard-watch.ts](src/main/clipboard-watch.ts).
- **poe.ninja's public API**: a third-party, unauthenticated JSON API (not GGG's), used for
  currency/unique pricing. See [poeninja-client.ts](src/pricing/poeninja-client.ts).
- **GGG's PoE2 Currency Exchange feed** (`web.poecdn.com/api/currency-exchange/poe2`): first-party,
  public and unauthenticated — GGG's API reference documents it as accessible without OAuth, and it
  needs no client id or registration. Used only as a fallback behind poe.ninja. Requests carry an
  app-identifying `User-Agent` and go through the same rate-limit throttling as everything else.
  See [currency-exchange-client.ts](src/pricing/currency-exchange-client.ts).
- **GGG's PoE2 trade API** (`www.pathofexile.com/api/trade2`): the same `search` → `fetch` pair the
  trade website calls, used to price Rare items, which no other source covers. It is public and
  unauthenticated — no client id, no login, no token — and GGG rate-limits it per IP. Requests carry
  an app-identifying `User-Agent` and are budgeted well under the advertised limits (see below).
  See [trade2-client.ts](src/pricing/trade2-client.ts).

Nothing in this app modifies game files, reads game memory, or automates any input toward PoE2.

## The panel

One panel, bottom-right, holding one list — and **two forms**.

**It rests as a heads-up display**: the last thing you pressed Ctrl+C on, anything still being
priced, and the map's running total while a map is going. Nothing else — no filters, no buttons, no
zone or price lines. About 70-90px tall, and that is what you see while playing.

**`Ctrl+Shift+L` opens the full panel** and makes it clickable in the same keypress, so the per-row
Edit button works straight away. Press it again to go back. **Nothing else ever changes the panel's
size** — entering or leaving a map doesn't, and neither does anything else. It stays exactly as you
left it until you press the key again.

The full form is what the rest of this section describes, and is where searching, repricing and
editing happen:

- **The header**: the zone you're in and how old the poe.ninja prices are. The map total shows in
  both forms, but only while a map is actually running — see below for what counts as one.
- **The list**: every drop ever captured, newest first. Identical stacks fold into one row
  ("Exalted Orb x10"), and it's searchable, sortable by value/time/name, and filterable to unpriced
  items. It scrolls; the header and the buttons underneath it stay put.
- **Export CSV / Clear all**: the whole list, and the only way to wipe it (two-step — the second
  press confirms, and there is no undo beyond the one-slot backup described below).

Every row has an **Edit** control for correcting a price; see below. It's hidden in the heads-up
form, where the row is a readout rather than a control — hovering still shows the item's full text.

Size it from the tray's **Settings…**, or with `overlay.panel` in settings.json (`width`,
`maxHeightPercent`). The window itself is a full-screen transparent click-through sheet, so the
panel's position is fixed — but it only takes clicks at all while the full list is open
(`Ctrl+Shift+L`), and passes everything straight to the game otherwise.

| hotkey | default | does |
| --- | --- | --- |
| `toggleList` | `Ctrl+Shift+L` | Opens the full list *and* makes the overlay clickable, so Edit works. Again closes both. The only thing that changes the panel's size, and the only way into interactive mode. |
| `forceCapture` | `Ctrl+\`` | Re-reads the clipboard even if it hasn't changed. |

**Rebind them from the tray's Settings…**: click a combination, press the keys you want, and Save —
the new binding takes effect immediately, with no restart. Every hotkey needs at least one of Ctrl,
Alt or Shift, since a global shortcut is taken from Path of Exile 2 as well. `Backspace` unbinds one
entirely. If Windows or another app already owns a combination the app says so and saves it anyway,
so it starts working once whatever holds it is closed.

The same window holds the panel size, the display currency, and whether the overlay hides when the
game isn't focused. On **Automatic**, an item priced off the trade site is shown in the currency its
cheapest listing was asking — a row taken from a seller asking 2 chaos reads `2c`, the way the market
reads — while everything else picks divine, chaos or exalted by size. Values are stored in chaos
throughout, so this only changes what you read. The league and contact email live under **Setup…**
instead — those are read once at startup by the pricing clients, so changing them restarts the app.

## Unpriced rares

poe.ninja publishes no rare prices at all (too mod-dependent), so rares are priced against GGG's
trade API instead (see below). **White base items go there too**, but only at item level 81 and
above — they are searched on item level alone, which is the whole of what a base is worth, and the
floor keeps the constant stream of low-level white drops from spending the rate-limit budget your
rares need. Both halves are settings (`trade2.useBaseItemSearch`, `trade2.baseItemMinLevel`).
Magic items are never searched: the game glues their affixes onto the base on one line, leaving no
base type to search with. When that comes back empty — or the search budget is spent — the
row's **Edit** control lets you type a value in yourself, or uncheck specific mod lines to loosen
the search and hit "Reprice via trade". That ignore-list is remembered on the item either way.

**The row says which kind of "no price" it hit**, because they ask completely different things of
you. Hover the badge for the full sentence, including the specifics for that item:

| badge | what happened | what to do |
|---|---|---|
| **rate limited** | The search budget was spent, so no lookup went out | Wait for the window, then Reprice |
| **prices loading** | poe.ninja's first refresh hadn't finished yet | Reprice now that prices are in |
| **search failed** | The search went out and broke — an HTTP error or a dropped connection | Reprice to try again |
| **no listings** | The search ran; the market has nothing matching | Nothing — repricing gives the same answer |
| **no chaos price** | Listings exist, but none quoted a convertible currency | Open the trade search and look |
| **not searchable** | A Magic item, with nothing reliable to search on | Price it by hand |
| **search skipped** | A setting says not to search items like this one | Change that setting, or price by hand |
| **no price data** | Not in poe.ninja and not on the currency exchange | Price it by hand |

The first three are shown in a cooler blue: those resolve on their own. The rest are the market's
answer, and repricing will not change them.

The mod list opens with **the mods the search actually used already ticked** — not everything. A row
left unticked is one the query never asked for, and it says which kind it is: `dropped` for a
low-tier affix the search shed to find a market at all, and `not searched` for one it could not ask
for, either because GGG indexes nothing matching that line or because it fed an aggregate the search
then had to drop. Re-tick anything you want demanded and press Reprice. Items priced before this
existed, and anything priced by poe.ninja rather than trade search, still open with every mod ticked
— there is no record of a search to show.

## Fallback pricing via GGG's Currency Exchange

When poe.ninja has no price for an item — or its data has gone stale, which covers it being down —
[currency-exchange-client.ts](src/pricing/currency-exchange-client.ts) falls back to GGG's own
Currency Exchange feed. poe.ninja stays primary; nothing it prices today changes.

Worth knowing about this data before trusting a number from it:

- **It is hourly aggregate history, never live.** GGG's reference states there is no current-hour
  data, so `currencyExchange.lookbackHours` starts a few hours back.
- **It only covers items traded on the currency exchange**, so it cannot price rares. That gap is
  still filled by typing a manual price on the row.
- **Prices are derived entirely from the feed**, including chaos-per-divine — so the fallback still
  works when poe.ninja is unreachable. Exalted is the exchange's busiest quote currency, so most
  items are priced against a hub (chaos/divine/exalted) and converted from there.
- **Thin markets are noisy**, spanning several-fold between an hour's low and high, so markets under
  `currencyExchange.minVolume` units traded are ignored and the rest are volume-weighted.

The feed identifies items only by internal metadata id and publishes no names, so
[exchange-metadata-ids.ts](src/pricing/exchange-metadata-ids.ts) holds a hand-maintained
name→id table. Coverage is deliberately partial — an unmapped item just falls through to unpriced,
which is safer than guessing. To check the table against live data and see which high-volume ids are
worth mapping next:

```bash
npm run verify:exchange-ids
```

If your league has little exchange activity, `currencyExchange.leagueOverride` prices against
another league (e.g. `"Standard"`) instead.

## Pricing rares via GGG's trade API

Rares are most of what drops and poe.ninja lists none of them, so
[trade2-client.ts](src/pricing/trade2-client.ts) prices them off GGG's PoE2 trade API. It matches
the item's non-ignored mod lines against GGG's public stat reference (`/api/trade2/data/stats`) and
searches by those as "at least this roll" filters rather than by base type alone — see
[trade-stats.ts](src/pricing/trade-stats.ts) for the text-to-stat-id matching (a documented
heuristic: ambiguous stats sharing identical display text resolve to the first match). It then takes
the **cheapest of the five cheapest listings**, which is the market floor — what you could sell the
item into today, not what it is nominally worth.

### It prices at the floor, and that is deliberate

Sorting by price ascending and taking the first five is the most conservative reading available, and
it is the one this app uses. The number it produces is genuinely low. Measured on a real four-mod
Ruby jewel — 236 matching online listings, of which GGG returns the 100 cheapest ids:

| ids fetched | prices |
| --- | --- |
| 0–4 (**what it fetches**) | `1 exalted`, straight through |
| 45–54 (the middle) | 29, 29, 30, 30, 30, 30, 30, 33, 40, 40 exalted |
| 90–99 (the dearest) | 5 chaos, 500 exalted, seven `1 divine` |

So that jewel is reported at 1 exalted while people selling the same thing are asking around 30.
Both numbers are true: PoE2's cheap end is a wall of dump listings, and this measures that wall on
purpose. Read a trade2 price as **"I could move this quickly for about X"**, not as an appraisal.

Two further biases point the same way: GGG caps `result` at 100 ids however many listings matched,
and the mod ladder below often settles on fewer than every mod. Widening `trade2.maxListings` takes
more of the cheap end, not a slice further up the market — there is no setting that moves the sample
up, by design.

**The row says how old that floor is**, in parentheses after the price:

```
Torment Knuckle          12ex (listed 3d ago)
```

That is when the cheapest listing — the one the price *is* — was posted. An old listing is one nobody
has bought at that price, which is worth knowing before undercutting it. The word "listed" is there
to separate it from the pickup time on the line below, which is a bare `14s ago`.

It only appears on a single, unfolded, trade2-priced item, and it is absent entirely for items
captured before this existed, since nothing rewrites the cache. A manual price removes it too — it
describes the trade figure, and a manual price replaces that.

### How many of an item's mods it requires

Every one of them, when that produces a real market — and it usually doesn't, which is why this is a
ladder rather than a single search. A lookup tries the item's full mod set first, then one fewer,
then the floor below, stopping at the first threshold with enough listings to price off. `count >= n`
is a superset of `count >= n+1`, so each step down can only add listings and the last rung is exactly
the query this used to send on its own.

How far it descends is `minListingsForMatch`, and the default of `1` means **stop at the first rung
that matched anything** — the most specific comparison available for the item. The tradeoff is real
and runs both ways. On a real Ruby jewel:

| mods required | listings | asking price |
| --- | --- | --- |
| all 4 | 1 | 30 chaos — one stranger's asking price |
| 3 of 4 | 9 | 1 divine |
| 2 of 4 | 263 | **25 exalted** |

Sellers of that jewel were asking around 10–30 exalted, so the deep rung is the one describing a
market — but it describes it for a looser item than the one you picked up. Raise the setting toward
`10` to prefer the market over the exact match. Note that the row does **not** show how many
listings a price came from, so a price off one listing looks like a price off twenty — the
`[pricing]` log line is the only place the sample size appears.

Every search is **Instant Buyout only** by default, which is the usual reason the app's answer
disagrees with the trade site. GGG's `status` filter is not an online/offline toggle — it chooses how
you'd buy the item:

| `trade2.listingStatus` | GGG's label | what it means |
| --- | --- | --- |
| `"securable"` *(default)* | Instant Buyout | buyable on the spot, no whisper, seller needn't be online |
| `"available"` | Instant Buyout and In Person | both routes |
| `"online"` | In Person (Online) | seller is online; whisper them and meet to trade |
| `"onlineleague"` | In Person (Online in League) | as above, this league's characters only |
| `"any"` | Any | everything, including sellers who logged off weeks ago |

The default is `"securable"` because it's the only one that matches what the price claims to be: a
floor you can sell into *today*. An in-person listing needs the seller to answer a whisper, so it
isn't executable on demand. It's also not the narrower market it sounds like — measured live on a
Sapphire Ring base, `"online"` returned 5678 listings and `"securable"` 10000+.

Pick one from the tray's **Settings…**, under *Trade search*. It applies to the next lookup — no
restart. If you installed before this default changed, the first launch after upgrading moves you
from `"online"` to `"securable"` once and then leaves the setting alone, so a choice you make in that
dropdown sticks. Note that **View search** on a row reopens the query that produced *that* price, so
a row priced before the change still opens an in-person search until you reprice it.

Widening costs accuracy in a specific way. Two real jewels, all of their mods required:

| item | online sellers | including offline |
| --- | --- | --- |
| Sapphire, 4 mods | 0 | 16 |
| Emerald, 4 mods | 0 | 5 |

An offline listing is a price nobody can buy at right now, and may be months stale — but on thin
items it can be the only comparable there is. Whatever you set, the messages name the listings that
were actually searched ("no instant-buyout listings…"), so what you read always matches the query.
The default therefore requires a rung to hold well more listings than the price is sampled over: the
sample only has to be fillable, but the rung has to describe a market before it is worth sampling at
all. Every price says which rung produced it — the log line, the row's reprice status, and a
`trade 2/4` badge on the item row when it had to relax.

#### How a search is relaxed: mods are dropped, never half-matched

Searching for every mod at once is the obvious reading of "price this item", and on its own it finds
nothing. Measured against the live API for one Sapphire Ring base:

| query | listings |
| --- | --- |
| base type only | 7673 |
| 2 mods, all required | 14 |
| 5 mods, all required | **0** |

So a search that misses has to be loosened somehow. There are two ways, and this app deliberately
uses only one of them.

The tempting one is to keep every mod and ask for "at least 4 of these 5". It finds listings — but a
listing matching 4 of 5 may be missing the single roll that makes your item valuable, and *which* 4
differs from listing to listing, so nothing can tell you what the price was actually based on. It
prices an item that isn't yours and can't say which. **That option was removed.**

What happens instead is that the search **drops** a mod outright and still demands all the rest, one
mod per attempt — the weakest first, which is how you'd narrow a search by hand. The surviving set is
known exactly, so the row can tell you: the mods that were dropped show up unticked and badged in
**Edit**, and the ones the price rests on stay ticked. `minModMatchRatio` sets how far this can go —
at the default, a five-mod rare never searches on fewer than three of its mods.

The cost is honest: a rare whose remaining mods nobody has listed together stays unpriced rather than
being given an approximate number. A real four-mod Diamond jewel matched 84 listings on any *one* of
its mods and **zero** on any two — that is the market, not a search bug.

Press **View search** on a row to open the exact query on the trade site. The mods it used are
ticked, and the ones it dropped are shown beside them unticked, so the whole picture is visible.
(Mods GGG indexes no filter for can't appear at all — those are the rows marked `not searched`.)

### Pricing armour

An armour piece is searched on the **defence totals the game prints** — `Armour: 1081` and friends —
not on the mods behind them. Those numbers already have every local mod and the item's quality baked
in, and they are what GGG's trade API indexes, so the mods that produced them are dropped from the
mod filters entirely.

This is the difference between a price and nothing. A real Soldier Cuirass came back with:

| query | listings |
| --- | --- |
| all 4 of its mods | **0** |
| 3 of its 4 mods | **0** |
| 2 of its 4 mods | 4 |

Two of those four filters were `+186 to Armour` and `38% increased Armour`, each pinned to that
item's exact roll — numbers no other item has. Searching "this base with at least 972 Armour" plus
its two *actual* affixes finds the market that was there all along, and costs one request instead of
three.

The floor is set below the item's own total (`defenceMinRatio`, 0.9 by default): asking for parity
would only match items strictly *better* than yours, which prices something you don't own. One
caveat worth knowing — GGG indexes these values at maximum quality while the clipboard prints them
at the item's current quality, and correcting for that exactly needs a table of base item values
this app doesn't carry. At 20% quality the number is already exact; below that the floor comes out
slightly low, which only widens the net.

If nothing at all is listed near your item's defences, the search is retried once ignoring them
rather than giving up, and the row is badged `~def` to say the price compares this base and these
mods at *any* armour.

**Read the resulting number as a floor, not an appraisal.** Matching 3 of 5 mods finds items that may
be worse on the other two, and the price is the cheapest of the five cheapest listings, so trade2
values skew low by design. That is the intended trade for a running loot total — an approximate
number beats a blank one — but it is well under what the item would fetch listed individually.

Some rares will still come back unpriced, and usually the reason is liquidity rather than the
search: an unpopular base can have literally zero online listings, in which case no filter setting
helps. The panel says which case it hit.

GGG's hosts do occasionally return a brief `502`, so a *transient* failure (any 5xx, or a dropped
connection) is retried before the item is written off — otherwise a one-second outage stores the
rare unpriced permanently, which reads exactly like "this base has no market".

### Advanced Item Descriptions

PoE2's **Advanced Item Descriptions** option (Options → UI) changes the copied text: affixes get
`{ Prefix Modifier "Polar" (Tier: 1) — Elemental, Cold }` headers, and the roll range is spliced
into the number — `Attacks Gain 20(19-20)% of Damage`. Both are handled, and handling them matters:
GGG's stat templates carry a bare `#`, so a range left in place matches nothing and the item quietly
falls back to a base-type-only search. On one real glove capture, 1 of 8 mods resolved to a stat id
before this was handled and 7 of 8 after — the other one has no template in GGG's reference at all.

**No account, client id, or login is involved.** Earlier versions of this file claimed the opposite,
so it's worth being explicit about why — two different APIs were being conflated:

| | GGG's OAuth API | The trade API |
|---|---|---|
| Endpoints | profile, stashes, characters, league accounts, currency exchange | `pathofexile.com/api/trade2/*` |
| Auth | registered `client_id` + scopes | none |
| Availability | registration closed; no trade-search endpoint or scope documented | open, rate-limited by IP |

The first is genuinely unavailable, and it never had a trade search endpoint to offer. The second is
undocumented but openly served, answers anonymous requests, and is what every third-party PoE trade
tool uses.

### Rate limits, and why lookups can be declined

The trade API limits by IP, not by application, and tightly — a live response advertises:

```
X-Rate-Limit-Ip: 5:10:60,15:60:300,30:300:1800,600:21600:3600
```

5 requests per 10s, 15/min, 30 per 5 min, 600 per 6h, each with its own lockout for exceeding it
(the 5-minute bucket locks you out for 30 minutes). A price lookup costs two requests, so ~15
lookups per five minutes is the hard ceiling — shared with everything else this app sends to
pathofexile.com.

Two layers keep it well underneath. [rate-limiter.ts](src/pricing/rate-limiter.ts) reacts to the
`X-Rate-Limit-*` headers on every response and backs off on 429s per `Retry-After`.
[trade-budget.ts](src/pricing/trade-budget.ts) is the proactive half: it caps searches per rolling
window and enforces minimum spacing between them.

The important design point is what happens when that budget runs out: the lookup is **declined, not
queued**. Sleeping would block the serial pricing queue for minutes and stall every
poe.ninja-priceable currency drop behind a pile of rares. Instead the extra rares are stored
unpriced with a reason naming the cooldown, and the row's **Reprice** button picks them up at human
pace.

**The wait is shown as a live countdown**, so you know when pressing Reprice is worth it. The panel
header gains a line while a cooldown is running, and every rate-limited row counts down in place:

```
Trade searches: ready in 4:32          <- panel header

Torment Knuckle       retry in 4:32    rate limited
Sapphire Ring         retry in 4:32    rate limited
```

Both reach zero together and flip to **ready to reprice** — the budget is per IP, so one window
covers every item at once. **Nothing is retried automatically.** A map's worth of rows all firing the
moment the window refilled would re-exhaust it immediately, so the countdown tells you when, and
pressing Reprice stays your decision.

Configure it under `trade2` in settings:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to switch rare pricing off entirely. Rares then stay unpriced until given a manual value. |
| `contactEmail` | `""` | Sent in the `User-Agent` so GGG can contact whoever is making the requests — that's you, the person running this install, not whoever wrote it. Optional: left blank, the contact clause is omitted rather than sent empty, and rare pricing works either way. Asked for during setup. |
| `maxSearchesPerWindow` | `8` | Searches allowed per `windowMs`. A lookup is its ladder rungs plus one fetch, so at worst 8 searches = 16 requests against GGG's 30 per 5 minutes. The other half of the bucket is left for other trade tools on the same IP — the limit is per connection, not per app. It was `12` until that headroom was judged too thin. |
| `windowMs` | `300000` | The rolling window, matching GGG's 300-second bucket. |
| `maxSearchesPerLongWindow` | `160` | A second budget over `longWindowMs`, enforced alongside the short one — at worst 320 of GGG's 600. Their 6-hour bucket carries an **hour-long** lockout, and the 5-minute window refills twelve times an hour, so nothing else stops a long session reaching it. |
| `longWindowMs` | `21600000` | The rolling window for the above, matching GGG's 21600-second bucket. |
| `minSearchIntervalMs` | `15000` | Spacing between searches, and the only thing shaping a burst against GGG's per-minute bucket: a lookup is one *budgeted* search plus an unbudgeted fetch, so 8 searches are up to 16 requests, and 15 per minute is a 5-minute lockout. At 15s any one minute holds ~8 requests. Costs nothing in throughput — the window budget is the real ceiling — and a lone drop waits not at all. |
| `searchBudgetMigrated` | `false` | A migration marker, not a preference. An install that predates the lower budget is moved from 12 / 240 / 10s to the values above once and this is stamped. Each key is judged on its own, so one you tuned by hand is kept while the others still move. Nothing to set by hand. |
| `maxListings` | `5` | How many of the **cheapest** results the price is taken from. Raising it widens the slice but keeps it anchored to the cheap end. GGG's fetch endpoint rejects more than 10 ids outright. |
| `listingStatus` | `"securable"` | Which listings count, via GGG's `status` filter — **not** an online/offline toggle. `"securable"` is Instant Buyout, `"online"` is In Person (Online), `"available"` is both, `"any"` includes sellers who logged off weeks ago. See the table above. In the tray's **Settings…**. |
| `listingStatusMigrated` | `false` | A migration marker, not a preference. An install that predates the `"securable"` default is moved off `"online"` once and this is stamped, so a deliberate `"online"` chosen in **Settings…** is never overridden. Nothing to set by hand. |
| `saleType` | `"buyout"` | Whether a listing has to be buyable on the spot. `"any"` also counts listings with no asking price — which have no number to contribute to a price taken from the cheapest matches. In the tray's **Settings…**. |
| `minListingPrice` | `1` | The cheapest listing worth counting. PoE2's cheap end is a wall of dump listings and the price is sampled from that end, so without this a rare routinely reports a fraction of a chaos. Sent to GGG, so it filters the search rather than the sample. An item with nothing at or above it is left unpriced rather than given a junk number. `0` switches it off. The unit is GGG's own cross-currency value, roughly one exalted, and deliberately carries no currency name — naming one asks for listings *quoted* in it and hides every other. |
| `minListingsForMatch` | `1` | Listings a rung needs before the ladder stops there. `1` takes the strictest rung that matched anything, which is the most specific price available. Raise toward `10` to walk past thin rungs to a rung that describes a market, at the cost of pricing a looser item. |
| `minModMatchRatio` | `0.5` | The fraction of an item's mods that must stay in the query — the floor the drop ladder can't shed past. At `0.5` a five-mod rare never searches on fewer than three. Raise toward 1 for prices that describe your exact item and more unpriced rares; lower to price more items off less of what makes them good. |
| `useDefenceFilters` | `true` | Search armour by its total Armour/Evasion/Energy Shield/Ward instead of by the individual mods that produced them — see "Pricing armour" above. `false` restores the old behaviour. |
| `defenceMinRatio` | `0.9` | The defence floor to search on, as a fraction of the item's own total: 1081 Armour becomes "at least 972". Raise toward 1 for closer comparables and more unpriced items. |
| `maxTransientRetries` | `1` | Extra attempts after a GGG 5xx or a dropped socket. Each spends another search from the budget. 4xx and 429 are never retried — the query was rejected, or the budget is already too high for this IP. |

## Activation

The overlay stays hidden and the clipboard poll stays idle until it detects PoE2's game process
running — no window sitting on your desktop and no clipboard polling when you're not playing. It
checks the Windows process list every few seconds against `poe2ProcessNames` in settings, a list of
candidate executables (default: `PathOfExileSteam.exe`, `PathOfExile.exe`, and a couple of older
variants). A list rather than one exact name because the client differs between the Steam and
standalone builds — `PathOfExileSteam.exe` is the real PoE2 client on Steam, living in
`steamapps/common/Path of Exile 2/`, while `PathOfExile_x64Steam.exe` is PoE **1**'s name and will
never match a PoE2 install.

If the process list never matches, you'll get a `[process-watch] no PoE2 process
found — looked for ...` warning naming what it searched for; add your `.exe` to
`poe2ProcessNames` and restart.

If you upgraded from an earlier build, a legacy `poe2ProcessName` string in your `settings.json`
under `%APPDATA%/poe2-loot-value-overlay/` is folded into the new list automatically on next load.

Once detected, capture starts; when PoE2 closes, capture pauses and the overlay hides — the app
keeps running in the tray. To read the list after playing, use the tray icon's "Show Overlay",
which also brings the panel up regardless of process state if detection ever doesn't fire (e.g. a
future game update renames the executable). "Hide Overlay" puts it away again without quitting.

### Following the game's focus

Because the overlay is `alwaysOnTop` at screen-saver level across the whole primary display, leaving
it up permanently would cover your browser or Discord whenever you alt-tab. So while PoE2 is running
the overlay follows the foreground window: visible when PoE2 is in front, hidden when it isn't. It
deliberately stays up when *you* are the one using it — interactive mode (the open list, via the
`toggleList` hotkey) and the tray's "Show Overlay" both override the hide, the latter until PoE2
next takes focus.

If focus detection can't start at all, the overlay fails *open* and stays visible rather than
becoming unreachable. "Game isn't running" is tracked separately from "focus-following is off" for
exactly this reason: conflating the two is what used to leave the overlay pinned to the desktop
after you closed the game.

Windows exposes no foreground-window information to Electron, and this app carries no native
dependencies, so [`ForegroundWatcher`](src/main/foreground-watch.ts) shells out to a single
long-lived PowerShell helper that polls `GetForegroundWindow` itself and prints only on change —
spawning a process per poll couldn't run at focus-tracking frequency. If that helper can't run at
all, the feature fails *open*: it logs once and the overlay reverts to being permanently visible.

All of these except `focusPollIntervalMs` are in the tray's **Settings…**, and apply as soon as you
save. They're also under `overlay` in settings.json:

| key | default | meaning |
| --- | --- | --- |
| `hideWhenGameUnfocused` | `true` | Set `false` for the old always-visible behaviour — worth doing if you play windowed on a second monitor. Also skips the helper process entirely. |
| `focusPollIntervalMs` | `400` | How often the foreground window is sampled. Not in the Settings window: it trades CPU against how quickly the overlay reacts, which is a tuning knob rather than a preference. |
| `hideDelayMs` | `500` | Grace period before hiding, so the momentary focus loss during loading screens and fullscreen mode switches doesn't flicker the overlay. |
| `panel.width` | `380` | Panel width in pixels. |
| `panel.maxHeightPercent` | `80` | How much of the display height the panel may take before the list starts scrolling. |

## Development

```bash
npm install
npm run build   # compile + copy renderer assets
npm run dev     # the iterative loop: rebuild and restart the app on every change
npm test        # parser/pricing/db unit tests
npm start        # run the overlay
npm run package  # produce a Windows installer + portable exe (see release/)
```

Packaging needs Windows Developer Mode enabled — electron-builder's `winCodeSign` step creates
symlinks and fails with a privilege error without it.

## License

[MIT](LICENSE).
