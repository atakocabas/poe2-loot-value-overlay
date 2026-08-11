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
  installed. Settings and the loot cache still live in `%APPDATA%/PoE2 Loot Value Overlay/`.

Neither is code-signed, so Windows SmartScreen will warn the first time you run one — *More info* →
*Run anyway*. If you'd rather not trust a binary, `npm run package` (see [Development](#development))
builds exactly these two files from this source.

## First run

The app asks for three things once, in a small setup window, because none of them can ship as a
working default. You can reopen it any time from the tray icon's **Settings…**.

- **League** — every price source is queried per league, and leagues rotate every few months. A name
  that doesn't match the one you're playing isn't an error anywhere; it just leaves everything
  unpriced.
- **Path to `Client.txt`** — found automatically if you own PoE2 on Steam: the app reads Steam's
  install path from the registry, walks the libraries listed in `libraryfolders.vdf`, and looks for
  the game under whichever one Steam says holds app `2694490`. Standalone installs in the default
  location are found too. Anything else, use **Browse…**. Leave it empty to run without map
  detection — everything else still works, drops just aren't grouped per map.
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
- **Client.txt log reading**: used only to auto-detect when you enter/leave a map, so loot gets
  grouped into sessions automatically. The policy explicitly allows reading log files "as long as
  the user is aware of what you are doing with that data" — this is that disclosure. See
  [logwatch.ts](src/main/logwatch.ts). Nothing is written back to the log.
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

One panel, bottom-right, holding one list:

- **The header**: the current map's running total, the zone, and how old the poe.ninja prices are.
- **The list**: every drop ever captured, newest first. Identical stacks fold into one row
  ("Exalted Orb x10"), and it's searchable, sortable by value/time/name, and filterable to unpriced
  items. It scrolls; the header and the buttons underneath it stay put.
- **Export CSV / Clear all**: the whole list, and the only way to wipe it (two-step — the second
  press confirms, and there is no undo beyond the one-slot backup described below).

Every row has an **Edit** control for correcting a price; see below.

Size it with `overlay.panel` in settings (`width`, `maxHeightPercent`). The window itself is a
full-screen transparent click-through sheet, so the panel's position is fixed — but it only takes
clicks at all in interactive mode (`Ctrl+Shift+O`), and passes everything straight to the game
otherwise.

| hotkey | default | does |
| --- | --- | --- |
| `toggleOverlay` | `Ctrl+Shift+O` | Interactive mode — the overlay takes clicks instead of passing them to the game. |
| `toggleSession` | `Ctrl+Shift+M` | Starts/ends a map session by hand, when log detection misses one. |
| `forceCapture` | `Ctrl+\`` | Re-reads the clipboard even if it hasn't changed. |

## Map sessions and unpriced rares

Every map is a "session", and items captured via Ctrl+C are recorded against it — that's what the
header's running total counts. The list itself is *not* scoped to a map: entering a new one resets
the total and leaves everything already captured in place, below the new drops.

poe.ninja publishes no rare prices at all (too mod-dependent), so rares are priced against GGG's
trade API instead (see below). When that comes back empty — or the search budget is spent — the
row's **Edit** control lets you type a value in yourself, or uncheck specific mod lines to loosen
the search and hit "Reprice via trade". That ignore-list is remembered on the item either way.

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
the **median of the middle of the results**, which approximates what the item would actually sell
for; the mean is dragged around by both 1-exalted placeholder listings and speculative asking prices.

### Why it samples the middle and not the cheapest listings

Sorting by price ascending and pricing off the first ten results sounds conservative and is in fact
useless: PoE2's cheap end is a wall of 1-exalted dump listings, so anything with more than ten
listings priced at the market floor rather than at its own worth. Measured on a real four-mod Ruby
jewel — 236 matching online listings, of which GGG returns the 100 cheapest ids:

| ids fetched | prices |
| --- | --- |
| 0–9 (the cheapest) | ten straight `1 exalted` |
| 45–54 (the middle) | 29, 29, 30, 30, 30, 30, 30, 33, 40, 40 exalted |
| 90–99 (the dearest) | 5 chaos, 500 exalted, seven `1 divine` |

The app reported that jewel at 1 exalted while people selling the same thing were asking around 30.
Fetching the middle ten and taking their median lands on the ~30 without being dragged by either
end. GGG caps `result` at 100 ids however many listings matched, so on a heavily traded base this is
the median of the 100 cheapest rather than of the whole market — still biased low, deliberately.

### How many of an item's mods it requires

Every one of them, when that produces a real market — and it usually doesn't, which is why this is a
ladder rather than a single search. A lookup tries the item's full mod set first, then one fewer,
then the floor below, stopping at the first threshold with enough listings to price off. `count >= n`
is a superset of `count >= n+1`, so each step down can only add listings and the last rung is exactly
the query this used to send on its own.

A rung has to clear `minListingsForMatch` to be taken at face value, because "strictest that matched
anything" prices an item off whoever happens to have listed something similar. On a real Ruby jewel:

| mods required | listings | median |
| --- | --- | --- |
| all 4 | 1 | 30 chaos — one stranger's asking price |
| 3 of 4 | 9 | 1 divine |
| 2 of 4 | 263 | **25 exalted** |

Sellers of that jewel were asking around 10–30 exalted, so only the deep rung describes the market.

Every search is **online sellers only** by default, which is the usual reason the app's answer
disagrees with the trade site. Two real jewels, all of their mods required:

| item | online | including offline |
| --- | --- | --- |
| Sapphire, 4 mods | 0 | 16 |
| Emerald, 4 mods | 0 | 5 |

An offline listing is a price nobody can buy at right now, and may be months stale — but on thin
items it can be the only comparable there is. Set `trade2.listingStatus` to `"any"` to count them;
the messages then stop saying "online listings", so what you read always matches what was searched.
The default therefore requires a rung to hold at least as many listings as the median is sampled
over. Every price says which rung produced it — the log line, the row's reprice status, and a
`trade 2/4` badge on the item row when it had to relax.

#### Why requiring *all* of them can't be the only setting

Searching for every mod at once — GGG's `stats` type `"and"` — is the obvious reading of "price this
item", and on its own it finds nothing. Measured against the live API for one Sapphire Ring base:

| query | listings |
| --- | --- |
| base type only | 7673 |
| 2 mods, all required | 14 |
| 5 mods, all required | **0** |
| 5 mods, 3 required | 44 |

An ordinary rare has four to six explicit mods, so an all-mods search alone leaves essentially every
rare unpriced. Searches therefore use `count` with a minimum, and `minModMatchRatio` sets how far
down the ladder may go (floor of 2, so one- and two-mod items keep every filter). A real four-mod
Diamond jewel matched 84 listings on any *one* of its mods and **zero** on any two, so no threshold
would have priced it — that is the market, not a search bug.

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

**Read the resulting number as a ballpark, not an appraisal.** Matching 3 of 5 mods finds items that
may be worse on the other two, and the sampled window is drawn from the cheapest 100 results, so
trade2 values skew low. That is the intended trade for a running loot total — an approximate number
beats a blank one — but it is not what the item would fetch listed individually.

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

Configure it under `trade2` in settings:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to switch rare pricing off entirely. Rares then stay unpriced until given a manual value. |
| `contactEmail` | `""` | Sent in the `User-Agent` so GGG can contact whoever is making the requests — that's you, the person running this install, not whoever wrote it. Optional: left blank, the contact clause is omitted rather than sent empty, and rare pricing works either way. Asked for during setup. |
| `maxSearchesPerWindow` | `10` | Searches allowed per `windowMs`. 10 searches = 20 requests, comfortably inside GGG's 30. |
| `windowMs` | `300000` | The rolling window, matching GGG's 300-second bucket. |
| `minSearchIntervalMs` | `5000` | Spacing between searches, so a burst of rare drops can't trip the 5-per-10s bucket. |
| `maxListings` | `10` | Listings sampled from the middle of the results for the median. GGG's fetch endpoint rejects more than 10 ids outright. |
| `listingStatus` | `"online"` | Whose listings count. `"any"` includes offline sellers — more comparables on thin items, priced against listings that may be stale and unreachable. |
| `maxModLadderSearches` | `3` | Mod thresholds one lookup may try, strictest first. Each rung that misses costs another request. `1` disables the ladder and searches only the floor. |
| `minListingsForMatch` | `10` | Listings a threshold needs before its price is trusted; under this the ladder keeps loosening. Lower to prefer specificity over sample depth. |
| `minModMatchRatio` | `0.5` | How far down the ladder may go, as a fraction of the item's mods. Raise toward 1 for stricter comparisons and more unpriced rares; lower for looser matches and prices further below the item's real worth. |
| `useDefenceFilters` | `true` | Search armour by its total Armour/Evasion/Energy Shield/Ward instead of by the individual mods that produced them — see "Pricing armour" above. `false` restores the old behaviour. |
| `defenceMinRatio` | `0.9` | The defence floor to search on, as a fraction of the item's own total: 1081 Armour becomes "at least 972". Raise toward 1 for closer comparables and more unpriced items. |
| `maxTransientRetries` | `1` | Extra attempts after a GGG 5xx or a dropped socket. Each spends another search from the budget. 4xx and 429 are never retried — the query was rejected, or the budget is already too high for this IP. |

## Activation

The overlay stays hidden and the clipboard poll stays idle until it detects PoE2's game process
running — no window sitting on your desktop and no clipboard polling when you're not playing. It
checks the Windows process list every few seconds against `poe2ProcessNames` in settings, a list of
candidate executables (default: `PathOfExileSteam.exe`, `PathOfExile.exe`, and a couple of older
variants). A list rather than one exact name because the client differs between the Steam and
standalone builds — `PathOfExileSteam.exe` is the real PoE2 client on Steam, living next to
`Client.txt`'s parent in `steamapps/common/Path of Exile 2/`, while `PathOfExile_x64Steam.exe` is
PoE **1**'s name and will never match a PoE2 install.

Map detection is **not** gated behind this. `Client.txt` is tailed from startup regardless, because
a single wrong executable name here used to silently disable map sessions entirely with no error to
show for it. If the process list never matches, you'll get a `[process-watch] no PoE2 process
found — looked for ...` warning naming what it searched for; add your `.exe` to
`poe2ProcessNames` and restart.

If you upgraded from an earlier build, a legacy `poe2ProcessName` string in your `settings.json`
under `%APPDATA%/poe2-loot-value-overlay/` is folded into the new list automatically on next load.

Once detected, capture starts; when PoE2 closes, capture pauses and the overlay hides — the app
keeps running in the tray. To read the list after a session, use the tray icon's "Show Overlay",
which also brings the panel up regardless of process state if detection ever doesn't fire (e.g. a
future game update renames the executable). "Hide Overlay" puts it away again without quitting.

### Following the game's focus

Because the overlay is `alwaysOnTop` at screen-saver level across the whole primary display, leaving
it up permanently would cover your browser or Discord whenever you alt-tab. So while PoE2 is running
the overlay follows the foreground window: visible when PoE2 is in front, hidden when it isn't. It
deliberately stays up when *you* are the one using it — interactive mode (the
`toggleOverlay` hotkey) and the tray's "Show Overlay" both override the hide, the latter until PoE2
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

Configure it under `overlay` in settings:

| key | default | meaning |
| --- | --- | --- |
| `hideWhenGameUnfocused` | `true` | Set `false` for the old always-visible behaviour — worth doing if you play windowed on a second monitor. Also skips the helper process entirely. |
| `focusPollIntervalMs` | `400` | How often the foreground window is sampled. |
| `hideDelayMs` | `500` | Grace period before hiding, so the momentary focus loss during loading screens and fullscreen mode switches doesn't flicker the overlay. |
| `panel.width` | `380` | Panel width in pixels. |
| `panel.maxHeightPercent` | `80` | How much of the display height the panel may take before the list starts scrolling. |

## Development

```bash
npm install
npm run build   # compile + copy renderer assets
npm test        # parser/pricing/db unit tests
npm start        # run the overlay
npm run package  # produce a Windows installer + portable exe (see release/)
```

Packaging needs Windows Developer Mode enabled — electron-builder's `winCodeSign` step creates
symlinks and fails with a privilege error without it.

## License

[MIT](LICENSE).
