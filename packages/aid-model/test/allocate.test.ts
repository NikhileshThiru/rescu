import { describe, expect, it } from "vitest";
import { aggregateHexes, allocate, type AllocationInput, type Band, DEFAULT_ALLOCATION, type Impact, tractTotalCents } from "../src/index.js";

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthetic(n: number, seed: number, bandWeights = [0.3, 0.35, 0.2, 0.1, 0.05]): AllocationInput[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    let x = r();
    let band = 0;
    while (band < 4 && x > bandWeights[band]!) x -= bandWeights[band++]!;
    return { households: 50 + Math.floor(r() * 3_000), svi: r(), band: band as Band };
  });
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
      const tracts = synthetic(5_000, seed);
      const { a, total, households } = check(tracts);
      expect(households).toBe(a.eligibleHouseholds);
      expect(total).toBe(a.potCents);
      expect(a.potCents).toBe(households * 100_000);
      expect(Math.abs(total / households / 100 - 1_000)).toBeLessThan(1);
    }
  });

  it("gives nothing below the eligibility threshold or outside the declared area", () => {
    const tracts: AllocationInput[] = [
      { households: 100, svi: 0.9, band: 0 },
      { households: 100, svi: 0.9, band: 1 },
      { households: 100, svi: 0.9, band: 4, declared: false },
      { households: 100, svi: 0.5, band: 3 },
    ];
    const a = allocate(tracts, { ...DEFAULT_ALLOCATION, minBand: 2 });
    expect([a.cents[0], a.cents[1], a.cents[2]]).toEqual([0, 0, 0]);
    expect(a.cents[3]).toBe(100_000); // the only eligible tract gets exactly the mean
    expect(a.eligibleHouseholds).toBe(100);
  });

  it("pays more for stronger wind and for higher vulnerability", () => {
    const tracts: AllocationInput[] = [
      { households: 1_000, svi: 0.5, band: 1 },
      { households: 1_000, svi: 0.5, band: 2 },
      { households: 1_000, svi: 0.5, band: 3 },
      { households: 1_000, svi: 0.5, band: 4 },
      { households: 1_000, svi: 0.1, band: 2 },
      { households: 1_000, svi: 0.9, band: 2 },
    ];
    const { a } = check(tracts);
    expect(a.cents[0]!).toBeLessThan(a.cents[1]!);
    expect(a.cents[1]!).toBeLessThan(a.cents[2]!);
    expect(a.cents[2]!).toBeLessThanOrEqual(a.cents[3]!);
    expect(a.cents[4]!).toBeLessThan(a.cents[1]!);
    expect(a.cents[1]!).toBeLessThan(a.cents[5]!);
  });

  it("clamps and redistributes when most households sit at the extremes", () => {
    // Mostly light wind plus a small, severe core: the core hits the cap, the rest absorb it.
    const tracts = synthetic(3_000, 7, [0, 0.9, 0.05, 0.03, 0.02]);
    const { a, total } = check(tracts);
    expect(total).toBe(a.potCents);
    expect(a.householdsAtMax).toBeGreaterThan(0);
    // Mostly severe: many at the cap would overshoot, so the floor tracts absorb it instead.
    const severe = synthetic(3_000, 8, [0, 0.05, 0.05, 0.2, 0.7]);
    const s = check(severe);
    expect(s.total).toBe(s.a.potCents);
  });

  it("handles a single tract and an empty disaster", () => {
    const one = allocate([{ households: 7, svi: 0.3, band: 4 }]);
    expect(one.cents[0]).toBe(100_000);
    const none = allocate([{ households: 7, svi: 0.3, band: 0 }]);
    expect(none.potCents).toBe(0);
    expect(none.eligibleHouseholds).toBe(0);
  });

  it("is resolution-independent: hex totals equal the pot at every H3 size", () => {
    const r = rng(99);
    const tracts = Array.from({ length: 2_000 }, () => ({
      lat: 29 + r() * 6,
      lon: -86 + r() * 6,
      households: 100 + Math.floor(r() * 2_000),
      svi: r(),
    }));
    const impacts: Impact[] = tracts.map(() => {
      const maxKt = 20 + r() * 110;
      return { maxKt, band: (maxKt >= 96 ? 4 : maxKt >= 64 ? 3 : maxKt >= 50 ? 2 : maxKt >= 34 ? 1 : 0) as Band, peakT: 0, t34: null, t50: null, t64: null };
    });
    const a = allocate(tracts.map((t, i) => ({ households: t.households, svi: t.svi, band: impacts[i]!.band })));
    for (const res of [3, 4, 5, 6]) {
      const hexes = aggregateHexes(tracts, impacts, a, res);
      expect(hexes.reduce((s, h) => s + h.aidCents, 0)).toBe(a.potCents);
      expect(hexes.reduce((s, h) => s + h.eligibleHouseholds, 0)).toBe(a.eligibleHouseholds);
    }
  });
});

describe("declared areas", () => {
  it("lets FEMA-designated tracts below the wind threshold qualify at the floor band", () => {
    const tracts: AllocationInput[] = [
      { households: 100, svi: 0.5, band: 0, declared: true }, // flooded, calm wind
      { households: 100, svi: 0.5, band: 0 }, // not declared, calm
      { households: 100, svi: 0.5, band: 3, declared: true },
    ];
    const a = allocate(tracts);
    expect(a.cents[0]).toBeGreaterThan(0);
    expect(a.cents[1]).toBe(0);
    expect(a.cents[0]!).toBeLessThan(a.cents[2]!);
    const strict = allocate(tracts, { ...DEFAULT_ALLOCATION, declaredFloorBand: null });
    expect(strict.cents[0]).toBe(0);
  });
});
