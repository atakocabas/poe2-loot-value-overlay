import type { ParsedItem, ParsedMod, PseudoStat } from "./types";
import { defencesOf } from "./defences";
import { modsOf } from "./mods";

/**
 * GGG's pseudo stat ids, confirmed against the live `/api/trade2/data/stats` pseudo group (36 entries
 * at the time of writing) and by a search returning 2024 listings for one of them.
 *
 * Hardcoded for the same reason `DEFENCE_FILTER_IDS` is: these can't be *matched* out of the
 * reference the way explicit stats are, because a pseudo template ("+#% total to all Elemental
 * Resistances") never appears verbatim on an item. They are derived from the item's real mods here,
 * which is why `pseudo` stays out of `MATCHABLE_GROUPS` in trade-stats.ts — feeding pseudo text into
 * the matcher would out-match real explicit mods on lines like "#% to Fire Resistance".
 *
 * The published group is much larger than this. The mod-count pseudos (`pseudo_number_of_prefix_mods`
 * and friends) describe how craftable an item is rather than what it sells for, and are deliberately
 * left out.
 *
 * **There is no `pseudo_total_armour`, no evasion and no ward** — energy shield is the only defence
 * GGG publishes a pseudo for. Armour and evasion are reachable solely through `equipment_filters`,
 * which is why that mechanism exists and why this one does not replace it.
 */
const PSEUDO_IDS = {
  elementalResistance: "pseudo.pseudo_total_elemental_resistance",
  fireResistance: "pseudo.pseudo_total_fire_resistance",
  coldResistance: "pseudo.pseudo_total_cold_resistance",
  lightningResistance: "pseudo.pseudo_total_lightning_resistance",
  chaosResistance: "pseudo.pseudo_total_chaos_resistance",
  life: "pseudo.pseudo_total_life",
  mana: "pseudo.pseudo_total_mana",
  energyShield: "pseudo.pseudo_total_energy_shield",
  increasedEnergyShield: "pseudo.pseudo_increased_energy_shield",
  attributes: "pseudo.pseudo_total_attributes"
} as const;

type Aggregate = keyof typeof PSEUDO_IDS;

/** What each aggregate is called in the row editor and in the reprice status line. */
const LABELS: Record<Aggregate, string> = {
  elementalResistance: "total Elemental Resistance",
  fireResistance: "total Fire Resistance",
  coldResistance: "total Cold Resistance",
  lightningResistance: "total Lightning Resistance",
  chaosResistance: "total Chaos Resistance",
  life: "total maximum Life",
  mana: "total maximum Mana",
  energyShield: "total maximum Energy Shield",
  increasedEnergyShield: "total increased maximum Energy Shield",
  attributes: "total Attributes"
};

/** Emitted in this order, so the editor lists the aggregates people price on first. */
const AGGREGATE_ORDER: Aggregate[] = [
  "elementalResistance",
  "fireResistance",
  "coldResistance",
  "lightningResistance",
  "chaosResistance",
  "life",
  "mana",
  "energyShield",
  "increasedEnergyShield",
  "attributes"
];

/** The three single-element totals, which `chooseResistanceAggregate` picks between and the combined one. */
const ELEMENTS = ["fireResistance", "coldResistance", "lightningResistance"] as const;

/**
 * How many contributing mods an aggregate needs before it is worth deriving. Two everywhere except
 * the three single-element resistance totals — see `chooseResistanceAggregate` for why one is exact
 * there and lossy everywhere else.
 */
const MIN_CONTRIBUTORS: Partial<Record<Aggregate, number>> = {
  fireResistance: 1,
  coldResistance: 1,
  lightningResistance: 1
};

const DEFAULT_MIN_CONTRIBUTORS = 2;

/**
 * How one mod line feeds one aggregate.
 *
 * `multiplier` is why this isn't a flat lookup: `+15% to all Elemental Resistances` grants 15 to each
 * of the three elements, so it contributes **45** to the elemental total, not 15. `+10 to all
 * Attributes` does the same for attributes. Getting that wrong understates a very common mod by
 * two-thirds and would price the item off far weaker comparables.
 *
 * Every pattern is anchored end to end and built from an explicit name alternation rather than `.*`,
 * for the reason spelled out in defences.ts: a loose tail folds away conditional stats like
 * `10% increased Armour during Soul Gain Prevention`, which GGG indexes separately.
 */
interface Contribution {
  aggregate: Aggregate;
  pattern: RegExp;
  multiplier: number;
}

const ELEMENT = "Fire|Cold|Lightning";
const ALL_ELEMENTAL = /^\+?[\d.]+% to all Elemental Resistances$/i;

const CONTRIBUTIONS: Contribution[] = [
  {
    aggregate: "elementalResistance",
    pattern: new RegExp(`^\\+?[\\d.]+% to (?:${ELEMENT}) Resistance$`, "i"),
    multiplier: 1
  },
  {
    aggregate: "elementalResistance",
    pattern: ALL_ELEMENTAL,
    multiplier: 3
  },
  // The same rolls again, split by element. Only one of these two views is ever emitted — see
  // `chooseResistanceAggregate`. `to all Elemental Resistances` counts **once** here where it counts
  // three times above, because it grants 15 to *this* element rather than 45 to the pool.
  { aggregate: "fireResistance", pattern: /^\+?[\d.]+% to Fire Resistance$/i, multiplier: 1 },
  { aggregate: "fireResistance", pattern: ALL_ELEMENTAL, multiplier: 1 },
  { aggregate: "coldResistance", pattern: /^\+?[\d.]+% to Cold Resistance$/i, multiplier: 1 },
  { aggregate: "coldResistance", pattern: ALL_ELEMENTAL, multiplier: 1 },
  {
    aggregate: "lightningResistance",
    pattern: /^\+?[\d.]+% to Lightning Resistance$/i,
    multiplier: 1
  },
  { aggregate: "lightningResistance", pattern: ALL_ELEMENTAL, multiplier: 1 },
  {
    aggregate: "chaosResistance",
    pattern: /^\+?[\d.]+% to Chaos Resistance$/i,
    multiplier: 1
  },
  { aggregate: "life", pattern: /^\+?[\d.]+ to maximum Life$/i, multiplier: 1 },
  { aggregate: "mana", pattern: /^\+?[\d.]+ to maximum Mana$/i, multiplier: 1 },
  {
    aggregate: "energyShield",
    pattern: /^\+?[\d.]+ to maximum Energy Shield$/i,
    multiplier: 1
  },
  {
    aggregate: "increasedEnergyShield",
    pattern: /^[\d.]+% increased maximum Energy Shield$/i,
    multiplier: 1
  },
  {
    aggregate: "attributes",
    pattern: /^\+?[\d.]+ to (?:Strength|Dexterity|Intelligence)$/i,
    multiplier: 1
  },
  { aggregate: "attributes", pattern: /^\+?[\d.]+ to all Attributes$/i, multiplier: 3 }
];

/** The leading number of a mod line — the same one the stat matcher's first capture group takes. */
const LEADING_NUMBER = /-?\d+(?:\.\d+)?/;

/**
 * Aggregates that must not be derived when the item displays the matching defence total.
 *
 * `+40 to maximum Energy Shield` is *global* on a ring and *local* on a body armour, and the text is
 * identical — the property line is the only thing that separates them. On the body armour it is
 * already inside the `Energy Shield:` total that `equipment_filters.es` searches, and
 * `isLocalDefenceMod` has already stripped it from the stat filters, so deriving a pseudo from it
 * would ask for the same energy shield twice.
 */
const SUPPRESSED_WHEN_DISPLAYED: Partial<Record<Aggregate, keyof ReturnType<typeof defencesOf>>> = {
  energyShield: "energyShield",
  increasedEnergyShield: "energyShield"
};

/**
 * The aggregate stat filters an item's mods add up to, each with the mod lines that fed it.
 *
 * Contributors ride along rather than being summed away because the row editor lets the user untick
 * individual mods, and the displayed total has to fall when they do — the renderer re-adds the
 * amounts of whatever is still ticked instead of classifying anything itself.
 *
 * **An aggregate needs at least two contributing mods to be worth deriving.** Folding a lone
 * `+38% to Fire Resistance` into "total elemental resistance >= 38" would happily match an item whose
 * 38 is all *cold* — looser without being any more accurate about what this item is. Two or more is
 * the point at which summing is what the market itself does.
 *
 * **The three single-element resistance totals are the stated exception** (`MIN_CONTRIBUTORS`), and
 * they are an exception because that argument does not reach them — a fire total cannot silently be
 * cold. See `chooseResistanceAggregate`, which also settles which of the two views is emitted.
 */
export function derivePseudoStats(item: Pick<ParsedItem, "mods" | "implicitMods" | "explicitMods" | "defences">): PseudoStat[] {
  return derivePseudoStatsFromMods(modsOf(item), defencesOf(item));
}

/**
 * Settles the combined elemental total against the three single-element ones, by deleting whichever
 * view is not being used. **They are alternatives, never both:** asking for "83% total elemental
 * *and* 38% of it fire" is narrower than either on its own, which is the opposite of what an
 * aggregate exists to do.
 *
 * The rule is that a per-element total wins when every resistance roll on the item names that same
 * element — which is exactly the case where the combined figure says less than the item does, since
 * "58% total elemental" also describes an item with 20 fire, 20 cold and 18 lightning.
 *
 * An `all Elemental Resistances` roll feeds all three, so its presence puts contributors in more than
 * one element and hands the decision back to the combined total. That is the honest answer: the item
 * really does carry all three.
 *
 * **One contributor is enough for a per-element total, unlike everywhere else.** The two-contributor
 * rule exists because folding a lone `+38% to Fire Resistance` into a *combined* total matches an
 * item whose 38 is all cold — looser without being more accurate. Against the fire total there is no
 * such slippage: "total fire resistance >= 38" is precisely what that mod says, and it additionally
 * finds listings that reach 38 through an `all Elemental Resistances` roll, which the explicit stat
 * filter for `#% to Fire Resistance` misses entirely. So it is strictly wider at no cost.
 */
function chooseResistanceAggregate(byAggregate: Map<Aggregate, PseudoStat["contributors"]>): void {
  const present = ELEMENTS.filter((element) => (byAggregate.get(element)?.length ?? 0) > 0);

  if (present.length === 1) {
    byAggregate.delete("elementalResistance");
    return;
  }
  for (const element of ELEMENTS) byAggregate.delete(element);
}

/** The same derivation over an explicit mod list, for callers that have already filtered one. */
export function derivePseudoStatsFromMods(
  mods: ParsedMod[],
  defences: ReturnType<typeof defencesOf>
): PseudoStat[] {
  const byAggregate = new Map<Aggregate, PseudoStat["contributors"]>();

  for (const mod of mods) {
    for (const { aggregate, pattern, multiplier } of CONTRIBUTIONS) {
      if (!pattern.test(mod.text)) continue;

      const suppressed = SUPPRESSED_WHEN_DISPLAYED[aggregate];
      if (suppressed && defences[suppressed] !== null) continue;

      const number = mod.text.match(LEADING_NUMBER);
      if (!number) continue;

      const contributors = byAggregate.get(aggregate) ?? [];
      // The affix tier rides along for the row editor, which shows it on the aggregate the same way
      // it does on a mod row — an 83% total made of one T1 and two fillers reads very differently
      // from three good rolls, and the summed number alone cannot say which it is.
      contributors.push({ text: mod.text, amount: Number(number[0]) * multiplier, tier: mod.tier });
      byAggregate.set(aggregate, contributors);
    }
  }

  chooseResistanceAggregate(byAggregate);

  const derived: PseudoStat[] = [];
  for (const aggregate of AGGREGATE_ORDER) {
    const contributors = byAggregate.get(aggregate);
    const minContributors = MIN_CONTRIBUTORS[aggregate] ?? DEFAULT_MIN_CONTRIBUTORS;
    if (!contributors || contributors.length < minContributors) continue;
    derived.push({
      id: PSEUDO_IDS[aggregate],
      label: LABELS[aggregate],
      contributors,
      minContributors
    });
  }
  return derived;
}

/** The total an aggregate is searched at, before any bound the user has set replaces it. */
export function pseudoTotal(stat: PseudoStat): number {
  return stat.contributors.reduce((sum, contributor) => sum + contributor.amount, 0);
}
