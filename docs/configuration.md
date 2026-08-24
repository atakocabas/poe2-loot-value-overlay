# Configuration: every settings.json key

What each key in `settings.json` does, for the person running the app. The file lives in
`%APPDATA%/poe2-loot-value-overlay/`, and missing keys are filled in from the shipped defaults on
every load, so an older file self-heals rather than needing a manual edit.

Most of this needs no editing at all. The keys with a control in the app are marked, and everything
else is a tuning knob with a working default.

For how the settings file is *loaded, merged and migrated* — the developer half — see
[settings.md](settings.md). Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---

## The two windows

The tray icon holds both, and which one a setting lives in follows one rule: **Settings…** carries
everything that can be applied in place, **Setup…** carries the two values three pricing clients read
once at startup — which is why saving from it restarts the app.

- **Setup…** — the league, and the optional contact email sent to GGG in the `User-Agent`.
- **Settings…** — the hotkeys, the panel's size and side, the display currency, whether the overlay
  hides when the game isn't focused, and four trade-search filters.

## Hotkeys

| hotkey | default | does |
| --- | --- | --- |
| `toggleList` | `Ctrl+Shift+L` | Opens the full list *and* makes the overlay clickable, so Edit works. Again closes both. The only thing that changes the panel's size, and the only way into interactive mode. |
| `forceCapture` | `Ctrl+\`` | Re-reads the clipboard even if it hasn't changed. |

**Rebind them from the tray's Settings…**: click a combination, press the keys you want, and Save —
the new binding takes effect immediately, with no restart. Every hotkey needs at least one of Ctrl,
Alt or Shift, since a global shortcut is taken from Path of Exile 2 as well. `Backspace` unbinds one
entirely. If Windows or another app already owns a combination the app says so and saves it anyway,
so it starts working once whatever holds it is closed.

## `overlay` — the panel and when it hides

Because the overlay is `alwaysOnTop` at screen-saver level across the whole primary display, leaving
it up permanently would cover your browser or Discord whenever you alt-tab. So while PoE2 is running
the overlay follows the foreground window: visible when PoE2 is in front, hidden when it isn't. It
deliberately stays up when *you* are the one using it — interactive mode (the open list, via the
`toggleList` hotkey) and the tray's "Show Overlay" both override the hide, the latter until PoE2
next takes focus. If focus detection can't start at all, the overlay fails *open* and stays visible
rather than becoming unreachable.

All of these except `focusPollIntervalMs` are in the tray's **Settings…**, and apply as soon as you
save.

| key | default | meaning |
| --- | --- | --- |
| `hideWhenGameUnfocused` | `true` | Set `false` for the old always-visible behaviour — worth doing if you play windowed on a second monitor. Also skips the helper process entirely. |
| `focusPollIntervalMs` | `400` | How often the foreground window is sampled. Not in the Settings window: it trades CPU against how quickly the overlay reacts, which is a tuning knob rather than a preference. |
| `hideDelayMs` | `500` | Grace period before hiding, so the momentary focus loss during loading screens and fullscreen mode switches doesn't flicker the overlay. |
| `panel.width` | `380` | Panel width in pixels. |
| `panel.maxHeightPercent` | `80` | How much of the display height the panel may take before the list starts scrolling. |
| `panel.position` | `"right"` | Which bottom corner the panel sits in. |

The window itself is a full-screen transparent click-through sheet, so the panel's position is fixed
— but it only takes clicks at all while the full list is open (`Ctrl+Shift+L`), and passes everything
straight to the game otherwise.

## `display`

| key | default | meaning |
| --- | --- | --- |
| `currency` | `"auto"` | What values are shown in. On **Automatic**, an item priced off the trade site is shown in the currency its cheapest listing was asking — a row taken from a seller asking 2 chaos reads `2c`, the way the market reads — while everything else picks divine, chaos or exalted by size. Values are stored in chaos throughout, so this only changes what you read. In the tray's **Settings…**. |

## `trade2` — rare pricing

Rares are priced against GGG's trade API, which is rate-limited **per IP**: another trade tool, or a
second copy of this app, spends the same budget. The defaults leave deliberate headroom — see
[pricing-trade2.md](pricing-trade2.md) for the measurements behind each one, and for why a lookup is
*declined* rather than queued when the budget runs out.

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
| `listingStatus` | `"securable"` | Which listings count, via GGG's `status` filter — **not** an online/offline toggle. `"securable"` is Instant Buyout, `"online"` is In Person (Online), `"available"` is both, `"any"` includes sellers who logged off weeks ago. In the tray's **Settings…**. |
| `listingStatusMigrated` | `false` | A migration marker, not a preference. An install that predates the `"securable"` default is moved off `"online"` once and this is stamped, so a deliberate `"online"` chosen in **Settings…** is never overridden. Nothing to set by hand. |
| `minListingsThresholdMigrated` | `false` | The same kind of marker, for the install that predates `minListingsForMatch` moving from 10 to 1. Nothing to set by hand. |
| `saleType` | `"buyout"` | Whether a listing has to be buyable on the spot. `"any"` also counts listings with no asking price — which have no number to contribute to a price taken from the cheapest matches. In the tray's **Settings…**. |
| `minListingPrice` | `1` | The cheapest listing worth counting. PoE2's cheap end is a wall of dump listings and the price is sampled from that end, so without this a rare routinely reports a fraction of a chaos. Sent to GGG, so it filters the search rather than the sample. An item with nothing at or above it is left unpriced rather than given a junk number. `0` switches it off. The unit is GGG's own cross-currency value, roughly one exalted, and deliberately carries no currency name — naming one asks for listings *quoted* in it and hides every other. |
| `minListingsForMatch` | `1` | Listings a rung needs before the ladder stops there. `1` takes the strictest rung that matched anything, which is the most specific price available. Raise toward `10` to walk past thin rungs to a rung that describes a market, at the cost of pricing a looser item. |
| `minModMatchRatio` | `0.5` | The fraction of an item's mods that must stay in the query — the floor the drop ladder can't shed past. At `0.5` a five-mod rare never searches on fewer than three. Raise toward 1 for prices that describe your exact item and more unpriced rares; lower to price more items off less of what makes them good. |
| `useModDropLadder` | `true` | Whether a search that finds nothing may **drop** a mod outright and demand all the rest — the weakest first. Off means one rung, every mod required, and an item with no market at those exact rolls stays unpriced. |
| `maxModDropSearches` | `5` | How many mods one lookup may shed, at one search each. A rare that walks every rung can spend most of a window by itself; lower it to spread the budget across more items. |
| `modDropTierThreshold` | `3` | Which affix tiers count as "weak" and are shed first. Raise it to shed more of the item before touching a good roll. |
| `useDefenceFilters` | `true` | Search armour by its total Armour/Evasion/Energy Shield/Ward instead of by the individual mods that produced them. `false` restores the old behaviour. |
| `defenceMinRatio` | `0.9` | The defence floor to search on, as a fraction of the item's own total: 1081 Armour becomes "at least 972". Raise toward 1 for closer comparables and more unpriced items. Also the floor for weapon eDPS, which is a continuous stat of the same kind. |
| `useWeaponFilters` | `true` | The same idea for weapons: search on elemental DPS rather than the damage mods behind it. |
| `usePseudoFilters` | `true` | Search GGG's aggregate stats — "83% total Elemental Resistance" — instead of the individual rolls feeding them, which is what the market actually prices. An aggregate is only derived when at least two mods feed it. |
| `pseudoMinRatio` | `0.9` | The aggregate floor, as a fraction of the item's own total, for the same reason as `defenceMinRatio`. |
| `useMapFilters` | `true` | Search a waystone on its printed reward totals rather than its affix text. In the tray's **Settings…**. |
| `mapMinRatio` | `0.9` | How far to widen those totals: `Item Rarity: +24%` becomes "at least 21". Edited as a percentage in the settings window. |
| `useBaseItemSearch` | `true` | Whether white base items are searched at all. |
| `baseItemMinLevel` | `81` | The item level a white base must reach to be worth a search — item level is the whole of what a base is worth, and the floor keeps the constant stream of low-level white drops from spending the budget your rares need. |
| `maxTransientRetries` | `1` | Extra attempts after a GGG 5xx or a dropped socket. Each spends another search from the budget. 4xx and 429 are never retried — the query was rejected, or the budget is already too high for this IP. |

## `currencyExchange` — the fallback source

When poe.ninja has no price for an item — or its data has gone stale, which covers it being down —
the app falls back to GGG's own Currency Exchange feed. Worth knowing about that data before trusting
a number from it: it is **hourly aggregate history, never live** (GGG publishes no current-hour data),
it **only covers items traded on the currency exchange**, so it cannot price rares, and thin markets
are noisy enough to span several-fold within one hour.

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to switch the fallback off, leaving poe.ninja as the only source. |
| `lookbackHours` | `6` | How far back to start reading. There is no current-hour data at all, so a seed of 0 or 1 would usually fetch nothing. |
| `maxPagesPerRefresh` | `6` | Hours walked forward per refresh, which caps the work when the stream is behind. |
| `refreshIntervalMs` | `3600000` | How often the feed is re-read — hourly, matching how often it is published. |
| `minVolume` | `20` | Markets with fewer units traded in the hour are ignored; the rest are volume-weighted. Thin markets span several-fold between an hour's low and high, and a confidently wrong price is worse than none. |
| `stalePoeNinjaAfterMs` | `3600000` | Consult the exchange when poe.ninja's data is older than this, not just when it has no price — which is what covers poe.ninja being down. |
| `leagueOverride` | `""` | Prices against another league (e.g. `"Standard"`) when yours has little exchange activity. |

The feed identifies items only by internal metadata id and publishes no names, so the app carries a
hand-maintained name→id table. Coverage is deliberately partial — an unmapped item falls through to
unpriced, which is safer than guessing. To check the table against live data and see which
high-volume ids are worth mapping next:

```bash
npm run verify:exchange-ids
```

## `updates`

| key | default | meaning |
| --- | --- | --- |
| `checkForUpdates` | `true` | Whether the app asks GitHub for the latest release at startup and on a timer. It never downloads or installs anything — it only tells you, in the tray menu and the panel header. There is no control for this in the settings window. |
| `checkIntervalMs` | `21600000` | How often to re-check after the one at startup. Six hours, because a release is not urgent. |

## `poeNinja` — the primary price source

Nothing here has a control in the app, and the two worth knowing about are both restraint rules:
poe.ninja is a free community service that publishes no rate limits and returns no `X-Rate-Limit-*`
headers, so there is nothing to react to — which argues for caution rather than against it.

| key | default | meaning |
| --- | --- | --- |
| `refreshIntervalMs` | `600000` | How often prices are pulled. One refresh is one request per configured category (~23), so shortening this multiplies traffic to a site that publishes no limit. Ten minutes is already ahead of how often poe.ninja recomputes; don't go below it. |
| `maxConcurrentRequests` | `4` | How many of those requests may be in flight at once. Firing all 23 simultaneously at a free service behind Cloudflare is the pattern that gets an IP blocked. |
| `baseUrl`, `itemOverviewTypes`, `exchangeOverviewTypes` | — | The endpoint and the categories fetched from it. Editing these is a code-level change in settings form. |

## `poe2ProcessNames` — how the app knows the game is running

The overlay stays hidden and the clipboard poll stays idle until it detects PoE2's game process
running — no window sitting on your desktop and no clipboard polling when you're not playing. It
checks the Windows process list every few seconds against this list of candidate executables
(default: `PathOfExileSteam.exe`, `PathOfExile.exe`, and a couple of older variants). A list rather
than one exact name because the client differs between the Steam and standalone builds —
`PathOfExileSteam.exe` is the real PoE2 client on Steam, living in
`steamapps/common/Path of Exile 2/`, while `PathOfExile_x64Steam.exe` is PoE **1**'s name and will
never match a PoE2 install.

If the process list never matches, you'll get a `[process-watch] no PoE2 process found — looked for
...` warning naming what it searched for; add your `.exe` to `poe2ProcessNames` and restart. If you
upgraded from an earlier build, a legacy `poe2ProcessName` string is folded into the new list
automatically on next load.

Once detected, capture starts; when PoE2 closes, capture pauses and the overlay hides — the app keeps
running in the tray. To read the list after playing, use the tray icon's **Show Overlay**, which also
brings the panel up regardless of process state if detection ever doesn't fire (e.g. a future game
update renames the executable). **Hide Overlay** puts it away again without quitting.

## `league`

Set during first-run setup, and changeable from the tray's **Setup…**. Every price source is queried
per league, and leagues rotate every few months. A name that doesn't match the one you're playing
isn't an error anywhere; it just leaves everything unpriced. Saving from that window restarts the
app, because the league is read at startup by three separate pricing clients.
