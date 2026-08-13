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
  "chaosResistance",
  "life",
  "mana",
  "energyShield",
  "increasedEnergyShield",
  "attributes"
];

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

const CONTRIBUTIONS: Contribution[] = [
  {
    aggregate: "elementalResistance",
    pattern: new RegExp(`^\\+?[\\d.]+% to (?:${ELEMENT}) Resistance$`, "i"),
    multiplier: 1
  },
  {
    aggregate: "elementalResistance",
    pattern: /^\+?[\d.]+% to all Elemental Resistances$/i,
    multiplier: 3
  },
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
 */
export function derivePseudoStats(item: Pick<ParsedItem, "mods" | "implicitMods" | "explicitMods" | "defences">): PseudoStat[] {
  return derivePseudoStatsFromMods(modsOf(item), defencesOf(item));
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
      contributors.push({ text: mod.text, amount: Number(number[0]) * multiplier });
      byAggregate.set(aggregate, contributors);
    }
  }

  const derived: PseudoStat[] = [];
  for (const aggregate of AGGREGATE_ORDER) {
    const contributors = byAggregate.get(aggregate);
    if (!contributors || contributors.length < 2) continue;
    derived.push({ id: PSEUDO_IDS[aggregate], label: LABELS[aggregate], contributors });
  }
  return derived;
}

/** The total an aggregate is searched at, before any bound the user has set replaces it. */
export function pseudoTotal(stat: PseudoStat): number {
  return stat.contributors.reduce((sum, contributor) => sum + contributor.amount, 0);
}
