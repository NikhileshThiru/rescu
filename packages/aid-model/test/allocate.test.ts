import { describe, expect, it } from "vitest";
import {
  aggregateHexes,
  allocate,
  type AllocationInput,
  type Band,
  DEFAULT_ALLOCATION,
  type Impact,
  specNeed,
  summarize,
  tractTotalCents,
} from "../src/index";
import { rng } from "./helpers";

/** Tracts with a skewed need distribution: most barely touched, a few devastated. */
function synthetic(n: number, seed: number, severity = 1): AllocationInput[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({
    households: 50 + Math.floor(r() * 3_000),
    svi: r(),
    need: Math.min(0.95, r() ** (3 / severity)),
  }));
}

function check(tracts: AllocationInput[], params = DEFAULT_ALLOCATION) {
  const a = allocate(tracts, params);
  let total = 0;
  let households = 0;
  tracts.forEach((t, i) => {
    if (a.score[i]! <= 0) {
      expect(a.cents[i]).toBe(0);
      return;
    }
    const lowest = a.cents[i]! + Math.min(0, a.extraCent[i]!);
    const highest = a.cents[i]! + (a.extraCent[i]! > 0 ? 1 : 0);
    expect(lowest).toBeGreaterThanOrEqual(params.minAid * 100);
    expect(highest).toBeLessThanOrEqual(params.maxAid * 100);
    total += tractTotalCents(a, i, t.households);
    households += t.households;
  });
  return { a, total, households };
}

describe("allocate (the aid model)", () => {
  it("averages exactly the mean, keeps every household in [$250, $2,000], and spends the whole pot", () => {
    for (const seed of [1, 2, 3, 42, 2024]) {
      const { a, total, households } = check(synthetic(5_000, seed));
      expect(households).toBe(a.eligibleHouseholds);
      expect(total).toBe(a.potCents);
      expect(a.potCents).toBe(households * 100_000);
      expect(Math.abs(total / households / 100 - 1_000)).toBeLessThan(1);
    }
  });

  it("gives nothing below the minimum need or outside the declared area", () => {
    const tracts: AllocationInput[] = [
      { households: 100, svi: 0.9, need: 0 },
      { households: 100, svi: 0.9, need: DEFAULT_ALLOCATION.minNeed / 2 },
      { households: 100, svi: 0.9, need: 0.8, declared: false },
      { households: 100, svi: 0.5, need: 0.3 },
    ];
    const a = allocate(tracts);
    expect([a.cents[0], a.cents[1], a.cents[2]]).toEqual([0, 0, 0]);
    expect(a.cents[3]).toBe(100_000); // the only eligible tract gets exactly the mean
    expect(a.eligibleHouseholds).toBe(100);
  });

  it("pays more where need is higher and where vulnerability is higher", () => {
    const tracts: AllocationInput[] = [
      { households: 1_000, svi: 0.5, need: 0.05 },
      { households: 1_000, svi: 0.5, need: 0.15 },
      { households: 1_000, svi: 0.5, need: 0.3 },
      { households: 1_000, svi: 0.1, need: 0.15 },
      { households: 1_000, svi: 0.9, need: 0.15 },
    ];
    const { a } = check(tracts);
    expect(a.cents[0]!).toBeLessThan(a.cents[1]!);
    expect(a.cents[1]!).toBeLessThan(a.cents[2]!);
    expect(a.cents[3]!).toBeLessThan(a.cents[1]!);
    expect(a.cents[1]!).toBeLessThan(a.cents[4]!);
  });

  it("clamps and redistributes when need is extremely skewed either way", () => {
    for (const severity of [0.3, 1, 3, 10]) {
      const { a, total } = check(synthetic(3_000, 7, severity));
      expect(total).toBe(a.potCents);
    }
    const { a } = check(synthetic(3_000, 11, 0.3));
    expect(a.householdsAtMax + a.householdsAtMin).toBeGreaterThan(0);
  });

  it("lets a county an official added by hand qualify through the need floor", () => {
    const tracts: AllocationInput[] = [
      { households: 100, svi: 0.5, need: 0, needFloor: 0.05 },
      { households: 100, svi: 0.5, need: 0 },
      { households: 100, svi: 0.5, need: 0.4 },
    ];
    const a = allocate(tracts);
    expect(a.cents[0]).toBeGreaterThan(0);
    expect(a.cents[1]).toBe(0);
    expect(a.cents[0]!).toBeLessThan(a.cents[2]!);
  });

  it("handles a single tract and an empty disaster", () => {
    expect(allocate([{ households: 7, svi: 0.3, need: 0.5 }]).cents[0]).toBe(100_000);
    const none = allocate([{ households: 7, svi: 0.3, need: 0 }]);
    expect(none.potCents).toBe(0);
    expect(none.eligibleHouseholds).toBe(0);
  });

  it("keeps the spec's band weights available as a baseline", () => {
    expect([0, 1, 2, 3, 4].map((b) => specNeed(b as Band))).toEqual([0, 0.3, 0.6, 1.0, 1.5]);
    const tracts = [1, 2, 3, 4].map((b) => ({ households: 100, svi: 0.5, need: specNeed(b as Band) }));
    const s = summarize(tracts, allocate(tracts), ["a", "b", "c", "d"]);
    expect(s.byGroup).toHaveLength(4);
    expect(s.meanAidUsd).toBeCloseTo(1_000, 6);
  });

  it("is resolution-independent: hex totals equal the pot at every H3 size", () => {
    const r = rng(99);
    const tracts = Array.from({ length: 2_000 }, () => ({
      lat: 29 + r() * 6,
      lon: -86 + r() * 6,
      households: 100 + Math.floor(r() * 2_000),
      svi: r(),
    }));
    const impacts: Impact[] = tracts.map(() => ({ maxKt: 20 + r() * 110, band: 0, peakT: 0, t34: null, t50: null, t64: null }));
    const a = allocate(tracts.map((t) => ({ households: t.households, svi: t.svi, need: r() * 0.5 })));
    for (const res of [3, 4, 5, 6]) {
      const hexes = aggregateHexes(tracts, impacts, a, res);
      expect(hexes.reduce((s, h) => s + h.aidCents, 0)).toBe(a.potCents);
      expect(hexes.reduce((s, h) => s + h.eligibleHouseholds, 0)).toBe(a.eligibleHouseholds);
    }
  });
});
