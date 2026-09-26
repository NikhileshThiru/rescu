import { describe, expect, it } from "vitest";
import {
  curve,
  destination,
  dominantHazard,
  hazardRate,
  modeledRainIn,
  type NeedParams,
  needProbability,
  paramsFromIncrements,
  rainRateInPerDay,
  sampleTrack,
  type Storm,
  surgeIndex,
} from "../src/index.js";

function straightStorm(opts: { hoursPerDegree: number; vmax: number }): Storm {
  const points = Array.from({ length: 6 }, (_, k) => ({
    t: k * opts.hoursPerDegree * 3_600,
    lat: 26 + k,
    lon: -85,
    vmax: opts.vmax,
    pmin: 960,
    status: "HU",
    record: "",
    rmw: 20,
    r34: [150, 150, 120, 120] as [number, number, number, number],
    r50: [80, 80, 60, 60] as [number, number, number, number],
    r64: [40, 40, 30, 30] as [number, number, number, number],
  }));
  return { id: "T", slug: "t", name: "Test", year: 2026, points, landfalls: [] };
}

describe("rain model (R-CLIPER)", () => {
  it("reproduces the published profile shape", () => {
    // At 35 kt (U = 1): T0 = 2.86 in/day at the centre, Tm = 3.2 in/day at rm = 51.5 km.
    expect(rainRateInPerDay(35, 0)).toBeCloseTo(2.86, 2);
    expect(rainRateInPerDay(35, 51.5)).toBeCloseTo(3.2, 2);
    expect(rainRateInPerDay(35, 51.5 + 134)).toBeCloseTo(3.2 / Math.E, 2);
    expect(rainRateInPerDay(120, 20)).toBeGreaterThan(rainRateInPerDay(40, 20));
    expect(rainRateInPerDay(0, 10)).toBeGreaterThanOrEqual(0);
  });

  it("dumps more rain when the storm crawls", () => {
    const at = [{ lat: 28.5, lon: -85 }];
    const fast = modeledRainIn(sampleTrack(straightStorm({ hoursPerDegree: 4, vmax: 90 })), at)[0]!;
    const slow = modeledRainIn(sampleTrack(straightStorm({ hoursPerDegree: 16, vmax: 90 })), at)[0]!;
    expect(slow).toBeGreaterThan(fast * 3);
    const far = modeledRainIn(sampleTrack(straightStorm({ hoursPerDegree: 8, vmax: 90 })), [{ lat: 28.5, lon: -76 }])[0]!;
    expect(far).toBeLessThan(0.5);
  });
});

describe("storm surge index", () => {
  const storm = sampleTrack(straightStorm({ hoursPerDegree: 6, vmax: 110 }));
  const [eLat, eLon] = destination(28, -85, 90, 25); // right of a northbound track
  const [wLat, wLon] = destination(28, -85, 270, 25); // left of it

  it("piles water up on the right side of the track, near the coast", () => {
    const [right, left, inland, farInland] = surgeIndex(storm, [
      { lat: eLat, lon: eLon, distCoastKm: 1 },
      { lat: wLat, lon: wLon, distCoastKm: 1 },
      { lat: eLat, lon: eLon, distCoastKm: 20 },
      { lat: eLat, lon: eLon, distCoastKm: 80 },
    ]);
    expect(right).toBeGreaterThan(1);
    expect(left!).toBeLessThan(right! * 0.2);
    expect(inland!).toBeLessThan(right!);
    expect(farInland).toBe(0);
  });
});

describe("need model", () => {
  const params: NeedParams = paramsFromIncrements(
    [0.001, 0.01, 0.03, 0.1, 0.1, 0.2, 0.2],
    [0.001, 0.005, 0.01, 0.02, 0.05, 0.05, 0.1],
    0.3,
    1.5,
    0.05,
  );
  const base = { windKt: 40, rainIn: 3, surge: 0, mobileShare: 0 };

  it("is zero with no hazard and a probability otherwise", () => {
    expect(needProbability({ windKt: 20, rainIn: 1, surge: 0, mobileShare: 0.5 }, params)).toBe(0);
    for (const kt of [30, 60, 100, 160]) {
      const p = needProbability({ ...base, windKt: kt }, params);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it("never falls as wind, rain, surge or mobile homes increase", () => {
    const monotone = (f: (x: number) => number, xs: number[]) => xs.slice(1).every((x, i) => f(x) >= f(xs[i]!) - 1e-12);
    const grid = Array.from({ length: 80 }, (_, i) => i * 2);
    expect(monotone((kt) => needProbability({ ...base, windKt: kt }, params), grid)).toBe(true);
    expect(monotone((r) => needProbability({ ...base, rainIn: r / 2 }, params), grid)).toBe(true);
    expect(monotone((s) => needProbability({ ...base, surge: s / 20 }, params), grid)).toBe(true);
    expect(monotone((m) => needProbability({ ...base, windKt: 90, mobileShare: m / 80 }, params), grid)).toBe(true);
  });

  it("counts moderate wind on soaked ground (trees on houses) beyond either alone", () => {
    const windy = hazardRate({ windKt: 55, rainIn: 0, surge: 0, mobileShare: 0 }, params);
    const wet = hazardRate({ windKt: 0, rainIn: 15, surge: 0, mobileShare: 0 }, params);
    const both = hazardRate({ windKt: 55, rainIn: 15, surge: 0, mobileShare: 0 }, params);
    expect(both).toBeGreaterThan(windy + wet);
  });

  it("interpolates its curves and names the hazard that drives need", () => {
    expect(curve(42, [34, 50], [0, 1])).toBeCloseTo(0.5, 9);
    expect(curve(10, [34, 50], [0, 1])).toBe(0);
    expect(curve(99, [34, 50], [0, 1])).toBe(1);
    expect(hazardRate({ windKt: 25, rainIn: 2, surge: 0, mobileShare: 0 }, params)).toBe(0);
    expect(dominantHazard({ windKt: 120, rainIn: 3, surge: 0, mobileShare: 0 }, params)).toBe("wind");
    expect(dominantHazard({ windKt: 36, rainIn: 25, surge: 0, mobileShare: 0 }, params)).toBe("rain");
    expect(dominantHazard({ windKt: 36, rainIn: 3, surge: 3, mobileShare: 0 }, params)).toBe("surge");
  });
});
