/**
 * Tunes the need model on FEMA's real household approvals across every storm in
 * data/config/storms.json, and measures it honestly: each demo storm is predicted by a model
 * that never saw it (leave-one-storm-out). Writes data/out/need-model.json and the committed copy
 * packages/aid-model/src/need-model.json. `pnpm data:fit` (after data:features)
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  bandOf,
  DEFAULT_ALLOCATION,
  distributionOverlap,
  fitNeedModel,
  type NeedParams,
  needProbability,
  spearman,
  specNeed,
  type TrainingCounty,
  type TrainingTract,
} from "@rescu/aid-model";
import { type FemaStorm, OUT_DIR, readFema, readStorms, readTracts, REPO_ROOT, type StormWithFlag, type TractRow } from "./lib.js";

const ITERATIONS = Number(process.env.FIT_ITERATIONS ?? 1_500);
/** A county enters a storm's study area if any tract saw real hazard. */
const STUDY = { windKt: 34, rainIn: 4, surge: 0.1 };
/** FEMA "helped" a county meaningfully if it approved at least this share of its households. */
const HELPED_SHARE = 0.01;

interface Row {
  tract: number;
  windKt: number;
  rainObs: number;
  rainModel: number;
  surge: number;
}

interface StormData {
  storm: StormWithFlag;
  fema: FemaStorm;
  rows: Row[];
  /** Study-area counties: households and FEMA-approved households. */
  counties: Map<string, { households: number; approved: number; designated: boolean }>;
}

const tracts = readTracts();
const tractIndex = new Map(tracts.map((t, i) => [t.geoid, i]));
const countyHouseholds = new Map<string, number>();
for (const t of tracts) countyHouseholds.set(t.countyFips, (countyHouseholds.get(t.countyFips) ?? 0) + t.households);
const fema = readFema();

function load(storm: StormWithFlag): StormData {
  const [, ...lines] = readFileSync(new URL(`features/${storm.slug}.csv`, OUT_DIR), "utf8").trim().split(/\r?\n/);
  const rows: Row[] = [];
  const study = new Set<string>();
  for (const line of lines) {
    const f = line.split(",");
    const tract = tractIndex.get(f[0]!);
    if (tract === undefined) continue;
    const row = { tract, windKt: Number(f[1]), rainObs: Number(f[5]), rainModel: Number(f[6]), surge: Number(f[7]) };
    rows.push(row);
    if (row.windKt >= STUDY.windKt || row.rainObs >= STUDY.rainIn || row.surge >= STUDY.surge) study.add(tracts[tract]!.countyFips);
  }
  const f = fema[storm.id]!;
  const designated = new Set(f.iaCounties);
  const counties = new Map<string, { households: number; approved: number; designated: boolean }>();
  for (const fips of study) {
    counties.set(fips, { households: countyHouseholds.get(fips) ?? 0, approved: f.ihp[fips]?.approved ?? 0, designated: designated.has(fips) });
  }
  return { storm, fema: f, rows: rows.filter((r) => study.has(tracts[r.tract]!.countyFips)), counties };
}

const hazard = (r: Row, t: TractRow, rain: "obs" | "model", rainScale: number) => ({
  windKt: r.windKt,
  rainIn: rain === "obs" ? r.rainObs : r.rainModel * rainScale,
  surge: r.surge,
  mobileShare: (t.pctMobileHome ?? 0) / 100,
});

function trainingSet(data: StormData[]) {
  const trainTracts: TrainingTract[] = [];
  const trainCounties: TrainingCounty[] = [];
  let storm = 0;
  for (const d of data) {
    const total = [...d.counties.values()].reduce((s, c) => s + c.approved, 0);
    if (total === 0) continue;
    const index = new Map<string, number>();
    for (const [fips, c] of d.counties) {
      index.set(fips, trainCounties.length);
      trainCounties.push({ storm, approved: c.approved, weight: 1 / total });
    }
    for (const r of d.rows) {
      const t = tracts[r.tract]!;
      trainTracts.push({ county: index.get(t.countyFips)!, households: t.households, propensity: t.svi, ...hazard(r, t, "obs", 1) });
    }
    storm++;
  }
  return { trainTracts, trainCounties };
}

/** Expected share of households in need, per study county. */
function predictCounties(d: StormData, need: (r: Row, t: TractRow) => number) {
  const expected = new Map<string, number>();
  for (const r of d.rows) {
    const t = tracts[r.tract]!;
    expected.set(t.countyFips, (expected.get(t.countyFips) ?? 0) + t.households * need(r, t));
  }
  return [...d.counties.entries()].map(([fips, c]) => ({ fips, ...c, expected: expected.get(fips) ?? 0 }));
}

function declareScore(counties: ReturnType<typeof predictCounties>, threshold: number) {
  const declared = counties.filter((c) => c.households > 0 && c.expected / c.households >= threshold);
  const hh = (xs: typeof counties) => xs.reduce((s, c) => s + c.households, 0);
  const approvedTotal = counties.reduce((s, c) => s + c.approved, 0);
  const designated = counties.filter((c) => c.designated);
  const both = declared.filter((c) => c.designated);
  const precision = hh(declared) ? hh(both) / hh(declared) : 0;
  const recall = hh(designated) ? hh(both) / hh(designated) : 0;
  return {
    counties: declared.length,
    designatedCounties: designated.length,
    /** Share of FEMA's approved households that live in counties we declared at landfall. */
    captureOfFemaHouseholds: approvedTotal ? declared.reduce((s, c) => s + c.approved, 0) / approvedTotal : 0,
    /** Household-weighted overlap with FEMA's designated counties. */
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
  };
}

const THRESHOLDS = [0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.1];

function evaluate(d: StormData, params: NeedParams, propensity: number, threshold: number, rainScale: number) {
  const need = (r: Row, t: TractRow, rain: "obs" | "model") => needProbability(hazard(r, t, rain, rainScale), params);
  const variants = {
    /** Hazard only: where the storm did damage. */
    hazard: predictCounties(d, (r, t) => need(r, t, "obs")),
    /** Plus FEMA's approval propensity: can we reproduce FEMA's actual pattern? */
    femaPattern: predictCounties(d, (r, t) => need(r, t, "obs") * (1 + propensity * t.svi)),
    /** What Rescu pays out: need x our vulnerability policy (0.7 to 1.3). */
    rescuPayout: predictCounties(d, (r, t) => need(r, t, "obs") * (DEFAULT_ALLOCATION.sviBase + DEFAULT_ALLOCATION.sviSlope * t.svi)),
    /** A drawn storm has no rain observations: hazard with the rain model instead. */
    modeledRain: predictCounties(d, (r, t) => need(r, t, "model")),
    /** The spec's original rule (wind bands only). */
    specRule: predictCounties(d, (r) => specNeed(bandOf(r.windKt))),
  };
  const actual = variants.hazard.map((c) => c.approved);
  const actualShare = variants.hazard.map((c) => (c.households ? c.approved / c.households : 0));
  const score = (xs: (typeof variants)["hazard"]) => ({
    overlap: distributionOverlap(xs.map((c) => c.expected), actual),
    spearman: spearman(xs.map((c) => (c.households ? c.expected / c.households : 0)), actualShare),
  });
  return {
    studyCounties: variants.hazard.length,
    femaApprovedHouseholds: actual.reduce((a, b) => a + b, 0),
    scores: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, score(v)])) as Record<keyof typeof variants, ReturnType<typeof score>>,
    declare: declareScore(variants.hazard, threshold),
  };
}

function chooseThreshold(data: StormData[], params: NeedParams) {
  let best = { threshold: THRESHOLDS[0]!, f1: -1 };
  for (const threshold of THRESHOLDS) {
    const f1s = data.map((d) => declareScore(predictCounties(d, (r, t) => needProbability(hazard(r, t, "obs", 1), params)), threshold).f1);
    const f1 = f1s.reduce((a, b) => a + b, 0) / f1s.length;
    if (f1 > best.f1) best = { threshold, f1 };
  }
  return best.threshold;
}

/** Bias correction for the rain model: observed / modeled storm totals near the track, median over storms. */
function rainScale(data: StormData[]) {
  const ratios = data
    .map((d) => {
      let obs = 0;
      let model = 0;
      for (const r of d.rows) {
        if (r.rainModel < 1) continue;
        obs += r.rainObs;
        model += r.rainModel;
      }
      return model > 0 ? obs / model : NaN;
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)]!;
}

let lastPropensity = 0;

function fit(data: StormData[], label: string) {
  const { trainTracts, trainCounties } = trainingSet(data);
  const t0 = performance.now();
  const result = fitNeedModel(trainTracts, trainCounties, { iterations: ITERATIONS });
  lastPropensity = result.propensity;
  const kappas = [...result.stormScale].sort((a, b) => a - b);
  console.log(
    `  fit ${label}: ${trainTracts.length.toLocaleString()} tracts, ${trainCounties.length} counties, ${((performance.now() - t0) / 1000).toFixed(1)} s; ` +
      `FEMA generosity ${kappas[0]!.toFixed(2)}..${kappas[kappas.length - 1]!.toFixed(2)}, approval propensity ${result.propensity.toFixed(2)}`,
  );
  return result.params;
}

const all = readStorms().map(load);
console.log(`loaded ${all.length} storms, ${all.reduce((s, d) => s + d.rows.length, 0).toLocaleString()} storm-tract rows`);
const scale = rainScale(all);
console.log(`rain model bias correction: x${scale.toFixed(2)}`);

type Validation = ReturnType<typeof evaluate> & { threshold: number };
const validation: Record<string, Validation> = {};
const heldOut = process.env.LOSO === "all" ? all : all.filter((d) => d.storm.demo);
for (const held of heldOut) {
  const train = all.filter((d) => d !== held);
  const params = fit(train, `without ${held.storm.name}`);
  const threshold = chooseThreshold(train, params);
  const v = { threshold, ...evaluate(held, params, lastPropensity, threshold, rainScale(train)) };
  validation[held.storm.slug] = v;
  const sc = v.scores;
  console.log(
    `  ${held.storm.name.padEnd(9)} overlap with FEMA: hazard ${sc.hazard.overlap.toFixed(2)}, FEMA pattern ${sc.femaPattern.overlap.toFixed(2)}, ` +
      `Rescu payout ${sc.rescuPayout.overlap.toFixed(2)}, rain model ${sc.modeledRain.overlap.toFixed(2)}, spec rule ${sc.specRule.overlap.toFixed(2)} | ` +
      `spearman ${sc.hazard.spearman.toFixed(2)} vs spec ${sc.specRule.spearman.toFixed(2)} | declared ${v.declare.counties} counties, ` +
      `${(100 * v.declare.captureOfFemaHouseholds).toFixed(0)}% of FEMA households`,
  );
}
const summary = (key: keyof Validation["scores"]) => {
  const xs = Object.values(validation).map((v) => v.scores[key].overlap).sort((a, b) => a - b);
  return { median: xs[Math.floor(xs.length / 2)]!, mean: xs.reduce((a, b) => a + b, 0) / xs.length };
};
const overall = Object.fromEntries((["hazard", "femaPattern", "rescuPayout", "modeledRain", "specRule"] as const).map((k) => [k, summary(k)]));
const wins = Object.values(validation).filter((v) => v.scores.hazard.overlap > v.scores.specRule.overlap).length;
console.log(`held-out storms: ${Object.keys(validation).length}; model beats the spec rule on ${wins}; median overlap hazard ${overall.hazard!.median.toFixed(2)} vs spec ${overall.specRule!.median.toFixed(2)}`);

const params = fit(all, "all storms");
const threshold = chooseThreshold(all, params);
const model = {
  fittedAt: new Date().toISOString(),
  trainedOn: all.map((d) => `${d.storm.name} ${d.storm.year}`),
  params,
  rainModelScale: scale,
  declareThreshold: threshold,
  target: "FEMA Individual & Households Program approvals (owners + renters) per county",
  approvalPropensity: lastPropensity,
  overall,
  validation,
};
const json = JSON.stringify(model, null, 1);
writeFileSync(new URL("need-model.json", OUT_DIR), json);
writeFileSync(new URL("packages/aid-model/src/need-model.json", REPO_ROOT), json);
console.log(`declare threshold ${threshold}; wind curve ${params.windValues.map((v) => v.toFixed(3)).join(" ")}; rain curve ${params.rainValues.map((v) => v.toFixed(3)).join(" ")}; surge ${params.surge.toFixed(3)}; mobile ${params.mobile.toFixed(2)}`);
console.log("wrote data/out/need-model.json and packages/aid-model/src/need-model.json");
