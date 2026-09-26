/**
 * Full-scale projection per storm under each eligibility rule, so the default is chosen on real
 * numbers. `pnpm data:report`
 */
import { readFileSync } from "node:fs";
import {
  allocate,
  type AllocationInput,
  autoDeclareCounties,
  BAND_LABELS,
  type Band,
  DEFAULT_ALLOCATION,
  summarize,
} from "@rescu/aid-model";
import { OUT_DIR, readStorms, readTracts, runStorm } from "./lib.js";

const bn = (x: number) => `$${(x / 1e9).toFixed(1)}B`;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const declared: Record<string, { counties: string[] }> = JSON.parse(readFileSync(new URL("declared_counties.json", OUT_DIR), "utf8"));
const tracts = readTracts();
const householdsIn = (counties: Set<string>) => tracts.reduce((s, t) => s + (counties.has(t.countyFips) ? t.households : 0), 0);

for (const storm of readStorms()) {
  const run = runStorm(storm, tracts);
  const fema = new Set(declared[storm.id]?.counties ?? []);
  const auto = autoDeclareCounties(tracts, run.impacts);
  const base: AllocationInput[] = tracts.map((t, i) => ({ households: t.households, svi: t.svi, band: run.impacts[i]!.band }));
  const within = (set: Set<string>) => base.map((t, i) => ({ ...t, declared: set.has(tracts[i]!.countyFips) }));
  const rules: [string, AllocationInput[], Exclude<Band, 0>][] = [
    ["FEMA IA counties (proposed default)", within(fema), 1],
    ["auto-declared counties (custom storms)", within(auto), 1],
    ["spec: anywhere >= 34 kt", base, 1],
    ["anywhere >= 50 kt", base, 2],
  ];
  const overlap = [...auto].filter((c) => fema.has(c));
  console.log(
    `\n=== ${storm.name} ${storm.year} (wind over ${tracts.length.toLocaleString()} tracts in ${run.ms.toFixed(0)} ms) ===\n` +
      `auto-declare vs FEMA: ${auto.size} vs ${fema.size} counties, covers ${((100 * householdsIn(new Set(overlap))) / Math.max(1, householdsIn(fema))).toFixed(0)}% of FEMA households`,
  );
  for (const [label, inputs, minBand] of rules) {
    const a = allocate(inputs, { ...DEFAULT_ALLOCATION, minBand });
    const s = summarize(inputs, a);
    const states = new Set(tracts.filter((_, i) => a.score[i]! > 0).map((t) => t.stateAbbr));
    console.log(
      `  ${label}: ${s.eligibleHouseholds.toLocaleString()} households in ${states.size} states, pot ${bn(s.potUsd)}\n` +
        `    by peak wind: ${s.byBand.map((b) => `${BAND_LABELS[b.band]} ${usd(b.meanAidUsd)}`).join(" | ")}`,
    );
  }
}
