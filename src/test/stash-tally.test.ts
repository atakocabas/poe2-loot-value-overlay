import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSnapshot, diffSnapshots } from "../shared/stash-tally";
import type { StashSnapshot } from "../shared/stash-tally";

/**
 * `stash-tally.ts` is pure by design — `priceOf` is injected — so these run against a fixed price
 * table with no client, no network and no Electron. The prices below are per unit, as everywhere
 * else in the app.
 */
const PRICES: Record<string, number> = {
  "Exalted Orb": 8,
  "Divine Orb": 200,
  "Chaos Orb": 1,
  "Orb of Alchemy": 0.5
};

const priceOf = (name: string): number | null => PRICES[name] ?? null;

const meta = { league: "Runes of Aldur", tabs: ["Currency"], takenAt: 1_700_000_000_000 };

describe("buildSnapshot", () => {
  test("multiplies per-unit price by stack size", () => {
    const snapshot = buildSnapshot([{ name: "Exalted Orb", stackSize: 50 }], priceOf, meta);

    assert.equal(snapshot.lines.length, 1);
    assert.equal(snapshot.lines[0].chaosPerUnit, 8);
    assert.equal(snapshot.lines[0].totalChaos, 400);
    assert.equal(snapshot.totalChaos, 400);
  });

  test("folds stacks of one currency split across slots into a single line", () => {
    const snapshot = buildSnapshot(
      [
        { name: "Exalted Orb", stackSize: 20 },
        { name: "Exalted Orb", stackSize: 30 },
        { name: "Chaos Orb", stackSize: 5 }
      ],
      priceOf,
      meta
    );

    const exalted = snapshot.lines.find((line) => line.name === "Exalted Orb");
    assert.equal(snapshot.lines.length, 2, "one line per currency, not per slot");
    assert.equal(exalted?.stackSize, 50);
    assert.equal(exalted?.totalChaos, 400);
    assert.equal(snapshot.totalChaos, 405);
  });

  test("an unpriced currency stays null and is excluded from the total, not added as zero", () => {
    const snapshot = buildSnapshot(
      [
        { name: "Chaos Orb", stackSize: 10 },
        { name: "Mystery Shard", stackSize: 99 }
      ],
      priceOf,
      meta
    );

    const mystery = snapshot.lines.find((line) => line.name === "Mystery Shard");
    assert.equal(mystery?.chaosPerUnit, null);
    assert.equal(mystery?.totalChaos, null, "no price is not a price of zero");
    assert.equal(snapshot.totalChaos, 10);
    assert.equal(snapshot.unpricedCount, 1);
  });

  test("sorts richest first and puts unpriced last", () => {
    const snapshot = buildSnapshot(
      [
        { name: "Mystery Shard", stackSize: 1 },
        { name: "Chaos Orb", stackSize: 5 },
        { name: "Divine Orb", stackSize: 3 },
        { name: "Exalted Orb", stackSize: 10 }
      ],
      priceOf,
      meta
    );

    assert.deepEqual(
      snapshot.lines.map((line) => line.name),
      ["Divine Orb", "Exalted Orb", "Chaos Orb", "Mystery Shard"]
    );
  });

  test("a missing or nonsensical stack size reads as one, matching the parser's default", () => {
    const snapshot = buildSnapshot(
      [
        { name: "Divine Orb", stackSize: 0 },
        { name: "Chaos Orb", stackSize: Number.NaN }
      ],
      priceOf,
      meta
    );

    assert.equal(snapshot.lines.find((l) => l.name === "Divine Orb")?.stackSize, 1);
    assert.equal(snapshot.lines.find((l) => l.name === "Chaos Orb")?.stackSize, 1);
  });

  test("carries the tabs it read, so a total can't be mistaken for a different set", () => {
    const snapshot = buildSnapshot([], priceOf, { ...meta, tabs: ["Currency", "Dump"] });

    assert.deepEqual(snapshot.tabs, ["Currency", "Dump"]);
    assert.equal(snapshot.totalChaos, 0);
    assert.equal(snapshot.takenAt, 1_700_000_000_000);
  });
});

describe("diffSnapshots", () => {
  const snap = (stacks: Array<{ name: string; stackSize: number }>, at = 1): StashSnapshot =>
    buildSnapshot(stacks, priceOf, { ...meta, takenAt: at });

  test("reports gains, losses and a net valued at the later price", () => {
    const before = snap([
      { name: "Exalted Orb", stackSize: 10 },
      { name: "Chaos Orb", stackSize: 100 }
    ]);
    const after = snap([
      { name: "Exalted Orb", stackSize: 25 },
      { name: "Chaos Orb", stackSize: 40 }
    ]);

    const diff = diffSnapshots(before, after);
    const exalted = diff.lines.find((line) => line.name === "Exalted Orb");
    const chaos = diff.lines.find((line) => line.name === "Chaos Orb");

    assert.equal(exalted?.delta, 15);
    assert.equal(exalted?.chaosDelta, 120);
    assert.equal(chaos?.delta, -60);
    assert.equal(chaos?.chaosDelta, -60);
    assert.equal(diff.netChaos, 60);
  });

  test("a currency present in only one snapshot still gets a line", () => {
    const diff = diffSnapshots(snap([{ name: "Chaos Orb", stackSize: 5 }]), snap([{ name: "Divine Orb", stackSize: 2 }]));

    assert.equal(diff.lines.find((line) => line.name === "Divine Orb")?.before, 0);
    assert.equal(diff.lines.find((line) => line.name === "Chaos Orb")?.after, 0);
    assert.equal(diff.netChaos, 400 - 5);
  });

  test("unchanged currencies are left out entirely", () => {
    const before = snap([
      { name: "Chaos Orb", stackSize: 5 },
      { name: "Divine Orb", stackSize: 2 }
    ]);
    const after = snap([
      { name: "Chaos Orb", stackSize: 5 },
      { name: "Divine Orb", stackSize: 3 }
    ]);

    assert.deepEqual(
      diffSnapshots(before, after).lines.map((line) => line.name),
      ["Divine Orb"]
    );
  });

  /**
   * The load-bearing case: the same stacks, priced differently between two reads. Differencing the
   * two snapshot totals would report 500 chaos of "gain" the player never picked up.
   */
  test("price movement between reads is not reported as a gain", () => {
    const before = buildSnapshot([{ name: "Divine Orb", stackSize: 5 }], () => 200, meta);
    const after = buildSnapshot([{ name: "Divine Orb", stackSize: 5 }], () => 300, meta);

    assert.equal(after.totalChaos - before.totalChaos, 500, "the totals really do differ");
    assert.deepEqual(diffSnapshots(before, after).lines, [], "but nothing moved");
    assert.equal(diffSnapshots(before, after).netChaos, 0);
  });

  test("an unpriced currency that moved is named, so the net is knowably incomplete", () => {
    const diff = diffSnapshots(
      snap([{ name: "Mystery Shard", stackSize: 1 }]),
      snap([
        { name: "Mystery Shard", stackSize: 7 },
        { name: "Chaos Orb", stackSize: 3 }
      ])
    );

    assert.deepEqual(diff.unpricedChanged, ["Mystery Shard"]);
    assert.equal(diff.netChaos, 3, "the priced half is still reported");
    assert.equal(diff.lines.find((line) => line.name === "Mystery Shard")?.chaosDelta, null);
  });
});
