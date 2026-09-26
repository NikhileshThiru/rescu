/**
 * The model against what these storms actually did at known places. Uses data/out/storms.json
 * from `pnpm data:prep`; skipped if it hasn't been generated.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { impactsAt, sampleTrack, type Storm } from "../src/index.js";

const file = new URL("../../../data/out/storms.json", import.meta.url);
const storms: Storm[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const byName = (name: string) => storms.find((s) => s.name === name)!;

type Case = [place: string, lat: number, lon: number, minKt: number, maxKt: number];

/**
 * Bounds are best-track (open-exposure) sustained winds, so they sit a little above what ground
 * stations recorded. Where the model is known to run hot (New Orleans), the bound says so.
 */
const cases: Record<string, Case[]> = {
  Helene: [
    ["Keaton Beach FL (landfall, Cat 4)", 29.822, -83.593, 96, 140],
    ["Perry FL (eyewall)", 30.117, -83.582, 96, 140],
    ["Valdosta GA (core crossed inland)", 30.833, -83.279, 80, 115],
    ["Tallahassee FL (west of the eye)", 30.438, -84.281, 34, 64],
    ["Atlanta GA (edge)", 33.749, -84.388, 20, 50],
    ["Asheville NC (tropical-storm winds, the damage was flooding)", 35.595, -82.551, 34, 64],
  ],
  Ian: [
    ["Cape Coral FL (landfall, Cat 4)", 26.563, -81.95, 96, 150],
    ["Fort Myers FL (eyewall)", 26.64, -81.872, 96, 150],
    ["Orlando FL (inland tropical storm)", 28.538, -81.379, 34, 80],
    ["Miami FL (far side)", 25.762, -80.192, 20, 50],
  ],
  Katrina: [
    ["Bay St. Louis MS (Mississippi landfall)", 30.309, -89.33, 96, 130],
    ["Buras LA (Louisiana landfall)", 29.35, -89.53, 96, 130],
    ["New Orleans LA (Cat 1-2 observed; model runs one category hot)", 29.951, -90.072, 64, 100],
    ["Mobile AL (hurricane-force edge)", 30.695, -88.04, 50, 80],
    ["Jackson MS (inland tropical storm)", 32.299, -90.185, 34, 64],
  ],
};

describe.skipIf(storms.length === 0)("wind model vs. real storms", () => {
  for (const [name, list] of Object.entries(cases)) {
    it(`${name}: eyewall, edges and inland decay land in the right category`, () => {
      const states = sampleTrack(byName(name), 600);
      const impacts = impactsAt(states, list.map(([, lat, lon]) => ({ lat, lon })));
      list.forEach(([place, , , min, max], i) => {
        const kt = impacts[i]!.maxKt;
        expect(kt, `${place}: ${kt.toFixed(0)} kt`).toBeGreaterThanOrEqual(min);
        expect(kt, `${place}: ${kt.toFixed(0)} kt`).toBeLessThanOrEqual(max);
      });
    });
  }

  it("runs a full storm (10-minute steps) fast enough to recompute live", () => {
    const t0 = performance.now();
    const states = sampleTrack(byName("Helene"), 600);
    const grid = Array.from({ length: 20_000 }, (_, i) => ({ lat: 25 + (i % 200) * 0.06, lon: -90 + Math.floor(i / 200) * 0.15 }));
    impactsAt(states, grid);
    expect(performance.now() - t0).toBeLessThan(3_000);
  });
});
