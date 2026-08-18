/**
 * The arithmetic behind the currency stash tally, kept pure and free of any client so it can be
 * unit-tested without a network, an Electron app or a `ParsedItem`.
 *
 * The shape mirrors how the rest of the app values things: prices are **per unit** and the stack
 * multiply happens once at the end, exactly as `totalChaosValue()` does for a drop. Getting that
 * backwards is the mistake that module's comment was written to prevent, and a stash tally is where
 * it would be least visible — every currency in a stash is a stack.
 */

/** The minimum a caller has to supply. `StashEntry` in `pricing/stash-client.ts` satisfies it. */
export interface StashStack {
  name: string;
  stackSize: number;
}

export interface TallyLine {
  name: string;
  /** Summed across every slot holding this currency — see `buildSnapshot`. */
  stackSize: number;
  chaosPerUnit: number | null;
  /** `null` when the currency has no price, which is not the same as being worth nothing. */
  totalChaos: number | null;
}

export interface StashSnapshot {
  takenAt: number;
  league: string;
  /** Display names of the tabs that were read, so a total can never be mistaken for a different set. */
  tabs: string[];
  lines: TallyLine[];
  /** Sum of the priced lines only. Unpriced lines are excluded, never added as zero. */
  totalChaos: number;
  unpricedCount: number;
}

export interface TallyDiffLine {
  name: string;
  before: number;
  after: number;
  /** Stack delta, negative when currency was spent. */
  delta: number;
  chaosDelta: number | null;
}

export interface TallyDiff {
  lines: TallyDiffLine[];
  netChaos: number;
  /** Names that moved but carry no price, so the net below is knowably incomplete. */
  unpricedChanged: string[];
}

/**
 * One line per currency, priced and sorted richest first.
 *
 * **Stacks of the same currency are folded before pricing, not after.** A currency tab holds one slot
 * per type, but an ordinary quad tab happily holds nine separate piles of Exalted Orbs, and pricing
 * each pile separately would produce nine rows the user has to add up by eye — the same noise
 * `groupItems` exists to remove from the loot list.
 *
 * `priceOf` is injected rather than a client being passed in, which is what keeps this module pure.
 */
export function buildSnapshot(
  stacks: StashStack[],
  priceOf: (name: string) => number | null,
  meta: { league: string; tabs: string[]; takenAt?: number }
): StashSnapshot {
  const folded = new Map<string, number>();
  for (const stack of stacks) {
    // A stack size the API omitted reads as 1, matching the parser's default for an item with no
    // `Stack Size:` line — a single orb is still one orb.
    const size = Number.isFinite(stack.stackSize) && stack.stackSize > 0 ? stack.stackSize : 1;
    folded.set(stack.name, (folded.get(stack.name) ?? 0) + size);
  }

  const lines: TallyLine[] = [...folded.entries()].map(([name, stackSize]) => {
    const chaosPerUnit = priceOf(name);
    return {
      name,
      stackSize,
      chaosPerUnit,
      totalChaos: chaosPerUnit === null ? null : chaosPerUnit * stackSize
    };
  });

  lines.sort(byTotalDesc);

  return {
    takenAt: meta.takenAt ?? Date.now(),
    league: meta.league,
    tabs: [...meta.tabs],
    lines,
    totalChaos: lines.reduce((sum, line) => sum + (line.totalChaos ?? 0), 0),
    unpricedCount: lines.filter((line) => line.totalChaos === null).length
  };
}

/**
 * What moved between two reads.
 *
 * **Each line is valued at the *later* snapshot's price, never as `after.totalChaos -
 * before.totalChaos`.** Differencing the two totals would fold poe.ninja's own price movement into
 * the figure and report it as currency the user gained or lost, which is the one thing this readout
 * must not do — a divine ticking up between two reads is not loot. Valuing the stack delta at today's
 * price answers the question actually being asked: what is what I picked up worth right now.
 *
 * A currency present in only one snapshot is still a line, with the missing side at zero.
 */
export function diffSnapshots(before: StashSnapshot, after: StashSnapshot): TallyDiff {
  const beforeByName = new Map(before.lines.map((line) => [line.name, line]));
  const afterByName = new Map(after.lines.map((line) => [line.name, line]));

  const lines: TallyDiffLine[] = [];
  for (const name of new Set([...beforeByName.keys(), ...afterByName.keys()])) {
    const beforeSize = beforeByName.get(name)?.stackSize ?? 0;
    const afterSize = afterByName.get(name)?.stackSize ?? 0;
    const delta = afterSize - beforeSize;
    if (delta === 0) continue;

    // The later price where there is one; the earlier as a fallback, since a currency spent to zero
    // has no line in `after` to carry a price at all.
    const perUnit = afterByName.get(name)?.chaosPerUnit ?? beforeByName.get(name)?.chaosPerUnit ?? null;
    lines.push({
      name,
      before: beforeSize,
      after: afterSize,
      delta,
      chaosDelta: perUnit === null ? null : perUnit * delta
    });
  }

  lines.sort((a, b) => {
    if (a.chaosDelta === null || b.chaosDelta === null) {
      return (a.chaosDelta === null ? 1 : 0) - (b.chaosDelta === null ? 1 : 0);
    }
    return b.chaosDelta - a.chaosDelta;
  });

  return {
    lines,
    netChaos: lines.reduce((sum, line) => sum + (line.chaosDelta ?? 0), 0),
    unpricedChanged: lines.filter((line) => line.chaosDelta === null).map((line) => line.name)
  };
}

/**
 * Unpriced sorts last rather than as zero, the same rule `byValueDesc` follows in the renderer: an
 * unknown price is not a low one, and burying the cheap-but-known rows under it would be worse.
 */
function byTotalDesc(a: TallyLine, b: TallyLine): number {
  if (a.totalChaos === null || b.totalChaos === null) {
    return (a.totalChaos === null ? 1 : 0) - (b.totalChaos === null ? 1 : 0);
  }
  return b.totalChaos - a.totalChaos;
}
