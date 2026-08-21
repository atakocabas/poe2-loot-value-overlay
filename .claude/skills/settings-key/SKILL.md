---
name: settings-key
description: Add, remove, rename or change the default of a key in this app's Settings. Use whenever a change touches src/shared/settings.ts, config/settings.default.json, or a field in the setup or settings window. Walks the three files that must move together, decides which window may edit the key, and determines whether a migration fold is needed to reach existing installs.
---

# Changing a Settings key

The repo's most error-prone recurring task. Six of the last sixty commits touched
`src/shared/settings.ts`, `config/settings.default.json` and `src/test/settings.test.ts` together,
and getting the set wrong fails **silently at runtime**, far from the change.

Read [docs/settings.md](../../../docs/settings.md) for the full reasoning. This is the checklist.

## 1. Move all three files together

| File | What it holds |
|---|---|
| `src/shared/settings.ts` | The `Settings` type. What the compiler checks against. |
| `config/settings.default.json` | The shipped values. **What `mergeWithDefaults` actually iterates.** |
| `src/test/settings.test.ts` → `makeDefaults()` | The fixture every test in that file builds on. |

**Why all three, and why the type is not enough.** `mergeWithDefaults` (`src/main/settings.ts`)
builds its result from the **defaults' key set**, not the type's. A key added to `Settings` but
forgotten in `settings.default.json` type-checks perfectly and is `undefined` at runtime — the exact
failure that function exists to prevent, arriving through the one door it doesn't watch. The reverse
is just as quiet: a key left in the defaults file after leaving the type is copied into every user's
`settings.json` forever, unread.

The parity test in `settings.test.ts` ("the shipped defaults and the fixture describe the same
shape") now fails loudly in both directions. It compares **key paths only** — do not make the
fixture a copy of the defaults, because the migration tests below need it holding the *old* shipped
values to have anything to migrate.

## 2. Decide which window may edit it — the "captured at construction" test

Ask: **does anything read this key once, at construction, and keep it?**

- **Yes → it belongs to the setup window** (`src/main/setup-window.ts`), which saves by
  **relaunching the app**. `league` is the worked example: it is captured in closures in `index.ts`
  and again in each of `PoeNinjaClient`, `Trade2Client` and `CurrencyExchangeClient`, so applying it
  live would take in some places and not others. `trade2.contactEmail` is the other — captured by
  `createPublicGggFetch`'s User-Agent.
- **No → it can go in the settings window** (`src/main/settings-window.ts`) and be applied in place.
  Add it to `SettingsConfig` in `src/shared/types.ts`.

`onSettingsSaved` in `src/main/index.ts` **mutates the live `settings` object rather than rebinding
it**, because `statusDeps`, `registerIpcHandlers` and the clipboard closure all hold that same
object.

**The `trade2` trap.** Its editable keys are assigned **field by field**, never as a block, because
their neighbours *are* captured at construction (`contactEmail` by the User-Agent, the budget numbers
by `TradeSearchBudget`). Replacing the whole `trade2` object would read as applied and silently not
be. If you are adding a `trade2` key to the settings window, add another field assignment.

Neither window is the default answer. Most of `settings.json` is a tuning knob with a working
default that needs no UI at all. The bar is **"can this be applied in place"**, not "is this
configurable".

## 3. Is it a *changed* default rather than a new key?

If so, **`mergeWithDefaults` will not reach a single existing install** — it fills in missing keys
only, so every current user keeps the old value invisibly.

Two folds exist for exactly this, in `src/main/settings.ts`:

- `adoptInstantBuyoutDefault()` — `trade2.listingStatus` `"online"` → `"securable"`
- `adoptListingThresholdDefault()` — `trade2.minListingsForMatch` `10` → `1`

Both surfaced as repeat "the trade site finds it and the app doesn't" reports before anyone thought
to check `git log` on the defaults file. Copy their shape:

1. Rewrite **only the exact old shipped value** — anything else could only have been chosen
   deliberately.
2. Take the new value **from the defaults file**, not a second literal, so the fold can't drift from
   what it exists to adopt.
3. Stamp a `*Migrated` marker key so a user who later picks the old value on purpose is never
   overridden. That marker is what makes the fold safe to keep once the key has a dropdown.
4. Add the marker to all three files in step 1.
5. Wire it into the load path and add tests alongside the existing migration tests.

**Assume the next changed default needs one too.** Two have now.

## 4. Guardrails

- **`trade2.contactEmail` must stay `""` and `league` must stay generic.** `settings.default.json`
  is public and installed on other people's machines — a real address there puts the committer in
  the `User-Agent` of every user's GGG requests.
- **A ratio edited as a percentage needs conversion at the form boundary.** `readNumber` in the
  settings renderer rounds to whole numbers, so a ratio typed directly rounds `0.9` to `1` and
  silently means "no widening at all". See `mapMinRatio`.
- **An empty accelerator is valid everywhere and means disabled.**
- `loadDefaultSettings()` backs the per-field Reset buttons, so "default" in the window means the
  same thing it means to `mergeWithDefaults`.

## 5. Finish

```bash
npm test
```

The parity test catches a missed file; the migration tests catch a fold that overreaches. If you
added or changed a settings-window field, also run `npm run dev` and open the window — nothing in
the suite exercises that renderer.
