# Settings: shape, defaults and migrations

`src/shared/settings.ts`, `src/main/settings.ts` and `config/settings.default.json`, plus which keys
each of the two configuration windows may edit.

Adding or changing a key? Use the `/settings-key` skill — it walks the three files that have to move
together and the fold question below.

Part of the [CLAUDE.md](../CLAUDE.md) reference set.

---


`loadSettings()` logs the file it resolved (`[settings] loaded <path>`) once per process. More than
one `settings.json` can exist on a machine — an unpackaged run and a packaged one resolve
`app.getPath("userData")` differently — so "the settings say X" is not a checkable claim without the
path beside it, and an afternoon went into discovering that the hard way.

`Settings` (`src/shared/settings.ts`) is loaded/saved via `src/main/settings.ts`, which copies
`config/settings.default.json` into `app.getPath("userData")/settings.json` on first run. On every
load, `mergeWithDefaults()` recursively fills in any key present in `config/settings.default.json`
but missing from the user's `settings.json` (and rewrites the file with the result), so an existing
install whose settings.json predates a schema change doesn't end up with `undefined` values at
runtime — it self-heals rather than needing a manual edit. When changing the `Settings` shape,
still update **both** `config/settings.default.json` and the type, so the merge has a default to
fall back to.

**Two keys ship blank or generic on purpose and must stay that way**, because the defaults file is
public and installed on other people's machines: `trade2.contactEmail` (`""` — it goes in the
`User-Agent` of every GGG request, so a real address here makes every user's traffic identify as
whoever committed it) and `league` (a plausible current league, since it's only ever a prefill the
user confirms). Don't commit a working value for either. `setupCompleted` defaults to `false`, which is what makes
the setup window appear once — including for installs upgrading past the key, since
`mergeWithDefaults` fills it in.

**Which keys the settings window may edit is a rule, not a list.** `SettingsConfig`
(`shared/types.ts`) is `hotkeys`, the editable part of `overlay`, `display.currency`, and four
`trade2` keys — `saleType`, `listingStatus`, `useMapFilters` and `mapMinRatio` — everything nothing
downstream captured, which is exactly what can be applied
without a relaunch. Adding a key there means checking that no client, closure or watcher read it at
construction; if one did, it belongs to the setup window and its restart instead. The four `trade2`
keys qualify on exactly that test and are worth reading as the worked example: `Trade2Client` holds
the same `Settings` object `index.ts` mutates and reads `this.settings.trade2.saleType` and
`.listingStatus` while building each query, and the two map keys while building a waystone's filters,
so a save reaches the very next lookup. Most of that block does **not** qualify — which is why
`onSettingsSaved` assigns those four **field by field** rather than replacing the `trade2` object.
`mapMinRatio` is stored as a ratio and edited as a percentage: `readNumber` rounds to whole numbers,
so a ratio typed directly would round 0.9 to 1 and silently mean "no widening at all".

**A changed default reaches new installs and nobody else**, which is what
`adoptInstantBuyoutDefault()` (`main/settings.ts`) exists for. `mergeWithDefaults` fills in *missing*
keys only, so when `trade2.listingStatus` moved from `"online"` to `"securable"` every existing
settings.json went on searching in-person listings — invisibly, since "View search" faithfully
reopens the same query and the trade site therefore agrees with the app. The fold rewrites an exact
`"online"` once and stamps `trade2.listingStatusMigrated`, so a deliberate `"online"` picked in the
settings window afterwards is never overridden. That marker is why the migration is safe to keep now
that the key has a dropdown; a fold that kept correcting the value would make that dropdown silently
not work. Only the old shipped default is touched — the other four options could only have been
typed by hand.

**`adoptListingThresholdDefault()` is the same fold for the same reason, and it is the one that
proves the rule.** `trade2.minListingsForMatch` shipped as **10** and moved to **1**; every install
predating that kept 10, so the ladder went on walking past the rung carrying an item's whole mod set
whenever fewer than ten listings had it. That surfaced as four separate "the trade site finds it and
the app doesn't" reports before anyone thought to check `git log` on the defaults file. It rewrites an
exact 10 once, stamps `trade2.minListingsThresholdMigrated`, and takes its target from the defaults
file rather than a second literal so the fold can't drift from what it exists to adopt.

**A default this shape needs a fold like this one, not just an edit to
`settings.default.json`.** Two have needed one now; assume the next will.
`loadDefaultSettings()` backs the per-field
Reset buttons, so "default" in the window means the same thing it means to `mergeWithDefaults`
rather than a second set of constants in the renderer.

---

## Non-goals / do not "fix"

- The setup window saving via a **restart** rather than applying values live is deliberate, and so is
  it covering only two settings. Don't "unify" it with the settings window: the restart is the
  honest way to apply a league three clients captured at construction, and a single dialog would have
  to restart for every change or lie about which ones need it.
- The settings window covering **only** hotkeys, the overlay block, the display currency and the
  two `trade2` search filters is the same rule from the other side, not an unfinished job. Everything else in `settings.json` is a
  tuning knob with a working default that no UI has to exist for. The bar for adding a field is "can
  this be applied in place", not "is this configurable" — see the Settings section above.

- A refused accelerator being **saved anyway** is deliberate. `globalShortcut.register` returning
  false means the combo is unavailable *right now*, usually because another app is running; refusing
  to store it would make the user's choice depend on what happened to be open at the time.
