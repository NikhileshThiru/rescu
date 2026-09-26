import { describe, expect, it } from "vitest";
import {
  destination,
  distanceNm,
  estimateRmwNm,
  impactsAt,
  isotachRing,
  radiusAtBearing,
  sampleTrack,
  type Storm,
  type StormState,
  windAtPolar,
} from "../src/index.js";

const hurricane: StormState = {
  t: 0,
  lat: 27,
  lon: -83,
  vmax: 120,
  rmw: 20,
  r64: [60, 50, 30, 40],
  r50: [90, 80, 50, 60],
  r34: [180, 150, 90, 120],
};

describe("wind field", () => {
  it("peaks at the eyewall and matches NHC's reported radii", () => {
    expect(windAtPolar(hurricane, 0, 0)).toBe(120);
    expect(windAtPolar(hurricane, 20, 200)).toBe(120);
    expect(windAtPolar(hurricane, 60, 45)).toBeCloseTo(64, 5);
    expect(windAtPolar(hurricane, 90, 45)).toBeCloseTo(50, 5);
    expect(windAtPolar(hurricane, 180, 45)).toBeCloseTo(34, 5);
    expect(windAtPolar(hurricane, 400, 45)).toBeLessThan(34);
  });

  it("falls off with distance in every direction", () => {
    for (let b = 0; b < 360; b += 15) {
      let prev = Infinity;
      for (let d = 0; d <= 300; d += 5) {
        const w = windAtPolar(hurricane, d, b);
        expect(w).toBeLessThanOrEqual(prev + 1e-9);
        prev = w;
      }
    }
  });

  it("blends quadrants smoothly (no pinwheel edges)", () => {
    let prev = windAtPolar(hurricane, 100, 0);
    for (let b = 1; b <= 360; b++) {
      const w = windAtPolar(hurricane, 100, b);
      expect(Math.abs(w - prev)).toBeLessThan(1.5);
      prev = w;
    }
    expect(radiusAtBearing([100, 0, 0, 0], 45)).toBe(100);
    expect(radiusAtBearing([100, 0, 0, 0], 90)).toBe(50);
    expect(radiusAtBearing([100, 0, 0, 0], 225)).toBe(0);
  });

  it("respects quadrants where NHC reports no tropical-storm winds", () => {
    const lopsided: StormState = { ...hurricane, vmax: 45, rmw: 50, r64: [0, 0, 0, 0], r50: [0, 0, 0, 0], r34: [170, 320, 0, 0] };
    expect(windAtPolar(lopsided, 10, 225)).toBeLessThan(34);
    expect(windAtPolar(lopsided, 150, 90)).toBeGreaterThanOrEqual(34);
  });

  it("estimates a plausible radius of max wind when it's missing", () => {
    const rmw = estimateRmwNm(110, 29.5);
    expect(rmw).toBeGreaterThan(12);
    expect(rmw).toBeLessThan(30);
    expect(estimateRmwNm(60, 30)).toBeGreaterThan(rmw);
  });

  it("draws the 64 kt ring at the reported radii", () => {
    const ring = isotachRing(hurricane, 64)!;
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    const [lon, lat] = ring[12]!; // 45 degrees = NE quadrant centre
    expect(distanceNm(hurricane.lat, hurricane.lon, lat, lon)).toBeCloseTo(60, 1);
    expect(isotachRing({ ...hurricane, vmax: 55 }, 64)).toBeNull();
  });

  it("records peak wind and arrival times along a moving storm", () => {
    const storm: Storm = {
      id: "T",
      slug: "t",
      name: "Test",
      year: 2026,
      landfalls: [],
      points: [0, 1, 2].map((h) => ({
        t: h * 21_600,
        lat: 25 + h,
        lon: -83,
        vmax: 100,
        pmin: 950,
        status: "HU",
        record: "",
        rmw: 20,
        r34: [150, 150, 150, 150],
        r50: [80, 80, 80, 80],
        r64: [40, 40, 40, 40],
      })),
    };
    const [lat, lon] = destination(26, -83, 90, 60); // 60 nm east of the track's midpoint
    const [imp] = impactsAt(sampleTrack(storm, 600), [{ lat, lon }]);
    expect(imp!.band).toBe(2);
    expect(imp!.peakT).toBeCloseTo(21_600, -3);
    expect(imp!.t34!).toBeLessThan(imp!.t50!);
    expect(imp!.t64).toBeNull();
  });
});
