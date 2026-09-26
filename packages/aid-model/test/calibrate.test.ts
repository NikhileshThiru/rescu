import { describe, expect, it } from "vitest";
import {
  distributionOverlap,
  fitNeedModel,
  needProbability,
  paramsFromIncrements,
  spearman,
  type TrainingCounty,
  type TrainingTract,
} from "../src/index";
import { rng } from "./helpers";

/**
 * Plants a known "true" need model, generates what FEMA would have approved under it, and checks
 * the fitter gets the predictions (and the shape) back.
 */
describe("fitting the need model", () => {
  const truth = paramsFromIncrements(
    [0.002, 0.01, 0.04, 0.12, 0.15, 0.25, 0.3],
    [0.001, 0.004, 0.01, 0.03, 0.06, 0.08, 0.1],
    0.25,
    1.2,
    0.04,
  );

  const TRUE_PROPENSITY = 0.8;

  /** Storms with different FEMA generosity, and approvals that also lean toward vulnerable tracts. */
  function world(seed: number, storms = 6, countiesPerStorm = 60) {
    const r = rng(seed);
    const tracts: TrainingTract[] = [];
    const counties: TrainingCounty[] = [];
    for (let s = 0; s < storms; s++) {
      const generosity = 0.3 + r() * 2.7;
      const first = counties.length;
      let stormTotal = 0;
      for (let c = 0; c < countiesPerStorm; c++) {
        const index = counties.length;
        counties.push({ storm: s, approved: 0, weight: 1 });
        const wind = 25 + r() * 110 * r();
        const rain = r() * 25 * r();
        const coastal = r() < 0.3;
        let expected = 0;
        for (let k = 0; k < 8; k++) {
          const t: TrainingTract = {
            county: index,
            households: 200 + Math.floor(r() * 3_000),
            windKt: Math.max(0, wind + (r() - 0.5) * 20),
            rainIn: Math.max(0, rain + (r() - 0.5) * 4),
            surge: coastal ? r() * 2.5 : 0,
            mobileShare: r() * 0.4,
            propensity: r(),
          };
          tracts.push(t);
          expected += t.households * needProbability(t, truth) * (1 + TRUE_PROPENSITY * t.propensity!);
        }
        counties[index]!.approved = Math.round(generosity * expected);
        stormTotal += counties[index]!.approved;
      }
      for (let c = first; c < counties.length; c++) counties[c]!.weight = 1 / Math.max(1, stormTotal);
    }
    return { tracts, counties };
  }

  /** Mean within-storm Spearman between modeled need (hazard only) and approvals. */
  function withinStormRank(w: ReturnType<typeof world>, params: typeof truth, eta = 0) {
    const modeled = new Float64Array(w.counties.length);
    w.tracts.forEach((t) => (modeled[t.county] = modeled[t.county]! + t.households * needProbability(t, params) * (1 + eta * t.propensity!)));
    const byStorm = new Map<number, number[]>();
    w.counties.forEach((c, i) => byStorm.set(c.storm, [...(byStorm.get(c.storm) ?? []), i]));
    const rhos = [...byStorm.values()].map((idx) => spearman(idx.map((i) => modeled[i]!), idx.map((i) => w.counties[i]!.approved)));
    return rhos.reduce((a, b) => a + b, 0) / rhos.length;
  }

  it("recovers a planted model despite storm-to-storm generosity and approval bias", () => {
    const train = world(5);
    let first = Infinity;
    const fit = fitNeedModel(train.tracts, train.counties, {
      iterations: 1_500,
      onProgress: (it, loss) => {
        if (it === 1) first = loss;
      },
    });
    expect(fit.loss).toBeLessThan(first);
    expect(withinStormRank(train, fit.params, fit.propensity)).toBeGreaterThan(0.97);
    expect(fit.propensity).toBeGreaterThan(0.3);
    expect(fit.stormScale).toHaveLength(6);

    // A held-out world from the same truth: hazard-only predictions still rank counties well.
    const test = world(99);
    expect(withinStormRank(test, fit.params)).toBeGreaterThan(0.93);
    expect(withinStormRank(test, fit.params)).toBeGreaterThan(withinStormRank(test, truth) - 0.03);

    // Curves stay non-decreasing and every weight stays non-negative.
    for (const values of [fit.params.windValues, fit.params.rainValues]) {
      values.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(values[i]!));
    }
    expect(fit.params.surge).toBeGreaterThanOrEqual(0);
    expect(fit.params.mobile).toBeGreaterThanOrEqual(0);
    // Hurricane-force wind matters far more than a tropical-storm breeze, as planted.
    const at = (kt: number) => needProbability({ windKt: kt, rainIn: 0, surge: 0, mobileShare: 0 }, fit.params);
    expect(at(120)).toBeGreaterThan(at(45) * 5);
  });

  it("measures how closely two distributions agree", () => {
    expect(distributionOverlap([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(distributionOverlap([1, 0], [0, 1])).toBe(0);
    expect(distributionOverlap([3, 1], [1, 1])).toBeCloseTo(0.75, 12);
  });

  it("computes Spearman rank correlation", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1, 1, 2], [1, 1, 2])).toBeCloseTo(1, 12);
  });
});
