import { describe, expect, it } from "vitest";
import {
  cFactor,
  combineScore,
  detectCollusion,
  detectGouging,
  detectVelocity,
  duplicateScore,
  FeatureModel,
  gougeScore,
  identityClusters,
  IsolationForest,
  mad,
  maskIdentity,
  median,
  mulberry32,
  neighborIndex,
  RESIDENT_FEATURES,
  type ResidentActivity,
  regionalMedians,
  robustStats,
  robustZ,
  severityOf,
  type ShelfItem,
} from "../src";

describe("robust stats", () => {
  it("median, MAD and robust z shrug off outliers", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
    const s = robustStats([10, 11, 9, 10, 10, 12, 8, 1000]);
    expect(s.median).toBe(10);
    expect(robustZ(10, s)).toBe(0);
    expect(robustZ(1000, s)).toBeGreaterThan(100);
    // A constant population doesn't blow up.
    expect(Number.isFinite(robustZ(2, robustStats([1, 1, 1]), 0.1))).toBe(true);
  });
});

describe("isolation forest", () => {
  it("c(n) matches the paper", () => {
    expect(cFactor(1)).toBe(0);
    expect(cFactor(2)).toBe(1);
    expect(cFactor(256)).toBeCloseTo(10.24, 1);
  });

  it("ranks planted outliers above normal points", () => {
    const rand = mulberry32(7);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const normal = Array.from({ length: 2000 }, () => [gauss(), gauss(), gauss() * 2, rand()]);
    const outliers = [
      [6, 6, 0, 0.5],
      [-5, 0, 12, 0.5],
      [0, 7, 0, 3],
      [8, -8, 9, 0.9],
    ];
    const f = new IsolationForest({ trees: 100, sampleSize: 256, seed: 3 }).fit([...normal, ...outliers]);
    const normalScores = normal.map((x) => f.score(x)).sort((a, b) => a - b);
    const p99 = normalScores[Math.floor(normalScores.length * 0.99)]!;
    for (const o of outliers) expect(f.score(o)).toBeGreaterThan(p99);
    expect(median(normalScores)).toBeLessThan(0.5);
    expect(f.score(outliers[0]!)).toBeGreaterThan(0.65);
    // Deterministic for a seed.
    const g = new IsolationForest({ trees: 100, sampleSize: 256, seed: 3 }).fit([...normal, ...outliers]);
    expect(g.score(outliers[1]!)).toBe(f.score(outliers[1]!));
  });

  it("feature model reports robust z per feature and a combined score", () => {
    const rand = mulberry32(11);
    const rows = Array.from({ length: 500 }, () => [rand() * 2, 0, rand() * 0.3, 0.3 + rand() * 0.4, 0, 0.05 + rand() * 0.05]);
    const m = new FeatureModel(RESIDENT_FEATURES, { seed: 1 }).fit(rows);
    const bad = [9, 4, 0.98, 1, 3, 0.4];
    const feats = m.features(bad);
    expect(feats.map((f) => f.name)).toEqual(RESIDENT_FEATURES.map((f) => f.name));
    expect(feats[0]!.z).toBeGreaterThan(5);
    const a = m.anomaly(bad);
    expect(a).toBeGreaterThan(m.anomaly(rows[0]!));
    expect(combineScore(0.6, a)).toBeGreaterThanOrEqual(0.6);
    expect(combineScore(0.9, 0.5)).toBe(0.9);
    expect(severityOf(0.85)).toBe("high");
    expect(severityOf(0.7)).toBe("medium");
    expect(severityOf(0.55)).toBe("low");
  });
});

describe("gouging", () => {
  // Six stores in a 20 km cluster and one 300 km away; item 0 = water ($5.99), item 1 = bread.
  const geo = [
    { lat: 30.8, lon: -83.3 },
    { lat: 30.85, lon: -83.28 },
    { lat: 30.75, lon: -83.35 },
    { lat: 30.82, lon: -83.2 },
    { lat: 30.9, lon: -83.3 },
    { lat: 30.78, lon: -83.25 },
    { lat: 33.5, lon: -83.3 },
  ];
  const pre = [599, 579, 619, 589, 609, 599, 999];
  const shelves = (water: number[]): ShelfItem[][] =>
    geo.map((_, s) => [
      { itemId: 0, preStormCents: pre[s]!, priceCents: water[s]! },
      { itemId: 1, preStormCents: 299, priceCents: 299 },
    ]);

  it("compares against the pre-storm regional median, not the store's own price", () => {
    const nb = neighborIndex(geo, 50);
    expect(nb[0]!.length).toBe(5);
    expect(nb[6]!.length).toBe(0);
    const med = regionalMedians(shelves(pre), nb);
    expect(med[0]!.get(0)).toBe(599);
    // The far store has no neighbours: it falls back to every store's median (599).
    expect(med[6]!.get(0)).toBe(599);
    expect(detectGouging(shelves(pre), med, 25)).toEqual([]);
  });

  it("flags a store 4x over the median with the worst item first, and not one 20% over", () => {
    const nb = neighborIndex(geo, 50);
    const price = [...pre];
    price[2] = 2399;
    price[3] = 699; // +17%: under the line
    const s = shelves(price);
    s[2]![1]!.priceCents = 499; // bread +67%
    const med = regionalMedians(s, nb);
    const hits = detectGouging(s, med, 25);
    expect(hits.map((h) => h.store)).toEqual([2]);
    expect(hits[0]!.items[0]!.itemId).toBe(0);
    expect(hits[0]!.items[0]!.ratio).toBeCloseTo(2399 / 599, 3);
    expect(hits[0]!.items[1]!.itemId).toBe(1);
    expect(gougeScore(4)).toBeGreaterThan(gougeScore(1.3));
    expect(gougeScore(1.3)).toBeGreaterThan(0.5);
  });
});

describe("duplicate identity", () => {
  const rec = (resident: number, device: string, phone: string, address: string) => ({ resident, device, phone, address });

  it("links households sharing a device, phone or address into one cluster", () => {
    const clusters = identityClusters([
      rec(0, "dev_aaaa0001", "(229) 555-0001", "1 Oak St"),
      rec(1, "dev_aaaa0002", "(229) 555-0002", "2 Oak St"),
      rec(2, "dev_shared99", "(229) 555-0003", "3 Oak St"),
      rec(3, "DEV_SHARED99", "229.555.0004", "4 Oak St"),
      rec(4, "dev_aaaa0005", "(229) 555-0004", "5 Oak St"),
      rec(5, "dev_aaaa0006", "(352) 555-0006", "12 Pine Ave, Valdosta GA"),
      rec(6, "dev_aaaa0007", "(352) 555-0007", "12 pine ave valdosta ga"),
    ]);
    expect(clusters.length).toBe(2);
    const a = clusters.find((c) => c.members.includes(2))!;
    expect(a.members).toEqual([2, 3, 4]);
    expect(a.key).toBe("device");
    expect(a.shared.phone).toBe(2);
    const b = clusters.find((c) => c.members.includes(5))!;
    expect(b.key).toBe("address");
    expect(duplicateScore(a)).toBeGreaterThan(duplicateScore(b));
  });

  it("masks the shared value", () => {
    expect(maskIdentity("phone", "(229) 555-0141")).toBe("(229) ***-**41");
    expect(maskIdentity("device", "dev_1a2b3c4d9f2c")).toBe("dev_…9f2c");
    expect(maskIdentity("address", "1234 Oak St, Lowndes GA")).toBe("1*** Oak St, …");
  });
});

describe("velocity", () => {
  const act = (resident: number, p: Partial<ResidentActivity>): ResidentActivity => ({
    resident,
    aidCents: 100_000,
    aidAt: 0,
    orders: 3,
    capHits: 0,
    spentCents: 20_000,
    spent48hCents: 10_000,
    lastAt: 3600,
    ...p,
  });

  it("flags repeated cap hits and fast draining, not ordinary shoppers or one-off rule breakers", () => {
    const normal = Array.from({ length: 200 }, (_, i) => act(i, { spent48hCents: 5_000 + (i % 20) * 1_000 }));
    const hits = detectVelocity([
      ...normal,
      act(1000, { capHits: 3 }),
      act(1001, { orders: 8, spent48hCents: 90_000, spentCents: 95_000 }),
      act(1002, { capHits: 1 }),
      act(1003, { orders: 2, spent48hCents: 95_000 }),
    ]);
    expect(hits.map((h) => h.resident).sort()).toEqual([1000, 1001]);
    expect(hits.find((h) => h.resident === 1000)!.reason).toBe("caps");
    expect(hits.find((h) => h.resident === 1001)!.z).toBeGreaterThan(3);
  });
});

describe("collusion", () => {
  it("needs both concentrated residents and an abnormal store volume", () => {
    const stores = Array.from({ length: 12 }, (_, s) => ({ store: s, category: "grocery", volumeCents: 200_000 + s * 10_000 }));
    stores[5]!.volumeCents = 3_000_000;
    const geo = stores.map((_, s) => ({ lat: 30 + s * 0.01, lon: -83 }));
    const nb = neighborIndex(geo, 50);
    const ring = [100, 101, 102, 103].map((resident) => ({ resident, aidCents: 150_000, spentCents: 140_000, orders: 4, store: 5, centsAtStore: 138_000 }));
    // Loyal but normal customers of store 2 (whose volume is ordinary).
    const loyal = [200, 201, 202].map((resident) => ({ resident, aidCents: 100_000, spentCents: 60_000, orders: 5, store: 2, centsAtStore: 60_000 }));
    // One small purchase is "100% at one store" but too little to count.
    const once = [300, 301, 302].map((resident) => ({ resident, aidCents: 100_000, spentCents: 3_000, orders: 1, store: 7, centsAtStore: 3_000 }));
    const hits = detectCollusion(stores, [...ring, ...loyal, ...once], nb);
    expect(hits.map((h) => h.store)).toEqual([5]);
    expect(hits[0]!.residents.length).toBe(4);
    expect(hits[0]!.concentration).toBeCloseTo(552_000 / 3_000_000, 3);
    expect(hits[0]!.z).toBeGreaterThan(2);
  });
});
