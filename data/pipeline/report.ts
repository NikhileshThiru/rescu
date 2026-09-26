/**
 * Full-scale projection for each demo storm under the tuned need model: counties Rescu declares
 * at landfall, who gets how much, and how it compares with what FEMA actually did.
 * `pnpm data:report` (after data:fit)
 */
import { readFileSync } from "node:fs";
import {
  allocate,
  autoDeclareCounties,
  DEFAULT_NEED_MODEL,
  distributionOverlap,
  dominantHazard,
  need,
  summarize,
  tractTotalCents,
} from "@rescu/aid-model";
import { OUT_DIR, readFema, readStorms, readTracts } from "./lib.js";

const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const bn = (x: number) => `$${(x / 1e9).toFixed(2)}B`;
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const model = JSON.parse(readFileSync(new URL("need-model.json", OUT_DIR), "utf8"));
const tracts = readTracts();
const byGeoid = new Map(tracts.map((t, i) => [t.geoid, i]));
const fema = readFema();

console.log(`need model fitted ${model.fittedAt} on ${model.trainedOn.length} storms; declare threshold ${model.declareThreshold}`);
if (model.overall) {
  console.log(
    `held-out overlap with FEMA's real split (median of ${Object.keys(model.validation).length} storms): ` +
      `model ${model.overall.hazard.median.toFixed(2)} vs spec rule ${model.overall.specRule.median.toFixed(2)}`,
  );
}

for (const storm of readStorms().filter((s) => s.demo)) {
  const f = fema[storm.id]!;
  const [, ...lines] = readFileSync(new URL(`features/${storm.slug}.csv`, OUT_DIR), "utf8").trim().split(/\r?\n/);
  const needByTract = new Float64Array(tracts.length);
  const hazardByTract: string[] = new Array(tracts.length).fill("none");
  for (const l of lines) {
    const x = l.split(",");
    const i = byGeoid.get(x[0]!);
    if (i === undefined) continue;
    const h = { windKt: Number(x[1]), rainIn: Number(x[5]), surge: Number(x[7]), mobileShare: (tracts[i]!.pctMobileHome ?? 0) / 100 };
    needByTract[i] = need(h);
    hazardByTract[i] = dominantHazard(h, DEFAULT_NEED_MODEL.params);
  }
  const declared = autoDeclareCounties(tracts, needByTract, DEFAULT_NEED_MODEL.declareThreshold);
  const inputs = tracts.map((t, i) => ({ households: t.households, svi: t.svi, need: needByTract[i]!, declared: declared.has(t.countyFips) }));
  const a = allocate(inputs);
  const s = summarize(inputs, a, hazardByTract);
  const states = new Set(tracts.filter((_, i) => a.score[i]! > 0).map((t) => t.stateAbbr));

  const county = new Map<string, { name: string; aid: number; hh: number }>();
  tracts.forEach((t, i) => {
    if (a.score[i]! <= 0) return;
    const c = county.get(t.countyFips) ?? { name: `${t.countyName}, ${t.stateAbbr}`, aid: 0, hh: 0 };
    c.aid += tractTotalCents(a, i, t.households) / 100;
    c.hh += t.households;
    county.set(t.countyFips, c);
  });
  const femaTotal = Object.values(f.ihp).reduce((x, c) => x + c.approved, 0);
  const allCounties = [...new Set([...county.keys(), ...Object.keys(f.ihp)])];
  const payoutOverlap = distributionOverlap(allCounties.map((c) => county.get(c)?.aid ?? 0), allCounties.map((c) => f.ihp[c]?.approved ?? 0));
  const captured = [...declared].reduce((x, c) => x + (f.ihp[c]?.approved ?? 0), 0);
  const designatedHit = f.iaCounties.filter((c) => declared.has(c)).length;
  const v = model.validation?.[storm.slug];

  console.log(`\n=== ${storm.name} ${storm.year} ===`);
  console.log(
    `Rescu declares ${declared.size} counties at landfall: ${s.eligibleHouseholds.toLocaleString()} households in ${states.size} states, pot ${bn(s.potUsd)}; ` +
      `aid ${usd(s.minAidUsd)}..${usd(s.maxAidUsd)}, median ${usd(s.medianAidUsd)}`,
  );
  console.log(`  by main hazard: ${s.byGroup.map((g) => `${g.group} ${g.households.toLocaleString()} hh at ${usd(g.meanAidUsd)}`).join(" | ")}`);
  console.log(
    `  FEMA scorecard: ${designatedHit} of FEMA's ${f.iaCounties.length} designated counties declared; ` +
      `declared counties hold ${pct(captured / femaTotal)} of the ${femaTotal.toLocaleString()} households FEMA approved; ` +
      `Rescu's dollars vs FEMA's approvals by county overlap ${payoutOverlap.toFixed(2)}`,
  );
  if (v) {
    console.log(
      `  held-out test (model never saw ${storm.name}): overlap with FEMA's split ${v.scores.hazard.overlap.toFixed(2)} ` +
        `(spec rule ${v.scores.specRule.overlap.toFixed(2)}; with only the rain model ${v.scores.modeledRain.overlap.toFixed(2)})`,
    );
  }
  const top = [...county.entries()].sort((x, y) => y[1].aid - x[1].aid).slice(0, 8);
  for (const [fips, c] of top) {
    const approved = f.ihp[fips]?.approved ?? 0;
    console.log(
      `    ${c.name.padEnd(28)} ${bn(c.aid).padStart(7)} to ${c.hh.toLocaleString().padStart(7)} hh (${usd(c.aid / c.hh)} each) | ` +
        `FEMA approved ${approved.toLocaleString()} (${pct(approved / c.hh)} of hh)`,
    );
  }
}
