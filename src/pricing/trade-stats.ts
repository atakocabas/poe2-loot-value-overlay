import type { GggFetch } from "./ggg-fetch";
import type { ModKind, ParsedMod } from "../shared/types";

const STATS_URL = "https://www.pathofexile.com/api/trade2/data/stats";

/**
 * Stat groups loaded from GGG's reference — exactly the kinds the parser can produce.
 *
 * The other groups GGG publishes are deliberately left out. `pseudo` holds synthetic aggregates
 * ("+# total to maximum Life") that never appear verbatim on an item, so matching against it would
 * invent filters the item doesn't have; `sanctum` and `skill` cover item classes this app doesn't
 * search by mods.
 */
const MATCHABLE_GROUPS: ModKind[] = [
  "explicit",
  "implicit",
  "rune",
  "enchant",
  "crafted",
  "fractured",
  "desecrated"
];

interface StatEntry {
  id: string;
  text: string;
  type: string;
}

interface StatGroup {
  id: string;
  entries: StatEntry[];
}

interface CompiledStat {
  statId: string;
  regex: RegExp;
}

export interface ModMatchResult {
  /**
   * `value` is null for a stat GGG indexes with no `#` at all — 1418 of the 3097 explicit templates,
   * e.g. "Cannot be Frozen". Those are matched on presence and carry no threshold.
   */
  matched: Map<string, { statId: string; value: number | null }>;
  unmatched: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turns a GGG stat template like "# to maximum Life" into a matcher for clipboard mod text. */
function compileTemplate(entry: StatEntry): CompiledStat {
  // Templates have no sign ("# to maximum Life"), but clipboard text does ("+80 to maximum
  // Life"), so the numeric capture allows an optional leading "+" (a leading "-" is just part
  // of the number itself).
  const pattern = escapeRegex(entry.text).replace(/#/g, "\\+?(-?[0-9.]+)");
  return { statId: entry.id, regex: new RegExp(`^${pattern}$`, "i") };
}

/**
 * Matches parsed item mod lines against GGG's public trade2 stat reference
 * (`/api/trade2/data/stats`, no auth required) so a rare item's mods can be turned into a trade2
 * search filter.
 *
 * **Each mod is looked up in its own group first.** That ordering is not a nicety: measured against
 * the live reference, `crafted`, `fractured` and `desecrated` are 100% subsets of `explicit` by
 * display text and `enchant` is 99%, so searching one pooled list and taking the first hit would
 * hand back an explicit stat id for a crafted mod almost every time — a filter for a different
 * item. `explicit` and `implicit` remain fallbacks, since 68% of implicit texts also appear as
 * explicit and PoE2 does not always mark which is which.
 *
 * Ambiguous stats sharing identical display text *within* a group resolve to whichever entry comes
 * first — the same heuristic trade-site tools use, since text alone can't separate them.
 * Multi-value stats (e.g. "Adds # to # Physical Damage") use only the first captured number.
 */
export class TradeStatsMatcher {
  private groups = new Map<ModKind, CompiledStat[]>();
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly gggFetch: GggFetch) {}

  async matchMods(mods: ParsedMod[]): Promise<ModMatchResult> {
    await this.ensureLoaded();

    const matched = new Map<string, { statId: string; value: number }>();
    const unmatched: string[] = [];

    for (const mod of mods) {
      this.matchLine(mod, matched, unmatched);
    }

    return { matched, unmatched };
  }

  private matchLine(
    mod: ParsedMod,
    matched: Map<string, { statId: string; value: number | null }>,
    unmatched: string[]
  ): void {
    for (const stat of this.searchOrder(mod.kind)) {
      const result = stat.regex.exec(mod.text.trim());
      if (result) {
        // A template with no `#` compiles to a regex with no capture group, so there is no number to
        // read. `Number(undefined)` is NaN, which `JSON.stringify` writes as `"min": null` — a
        // filter GGG matches nothing against, silently zeroing the whole search. Null here means
        // "no threshold", and the caller omits `value` entirely.
        matched.set(mod.text, {
          statId: stat.statId,
          value: result[1] === undefined ? null : Number(result[1])
        });
        return;
      }
    }
    unmatched.push(mod.text);
  }

  /** The mod's own group first, then the two general ones, each group used at most once. */
  private searchOrder(kind: ModKind): CompiledStat[] {
    const order: CompiledStat[] = [];
    const used = new Set<ModKind>();

    for (const group of [kind, "explicit", "implicit"] as ModKind[]) {
      if (used.has(group)) continue;
      used.add(group);
      order.push(...(this.groups.get(group) ?? []));
    }
    return order;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const response = await this.gggFetch(STATS_URL);
      if (!response.ok) return;

      const body = (await response.json()) as { result: StatGroup[] };
      for (const kind of MATCHABLE_GROUPS) {
        this.groups.set(kind, (body.result.find((g) => g.id === kind)?.entries ?? []).map(compileTemplate));
      }
    } catch (error) {
      console.warn("[trade-stats] failed to load stat reference data:", error);
      // Leave the groups empty — callers fall back to a base-type-only search.
      this.loadPromise = null;
    }
  }
}
