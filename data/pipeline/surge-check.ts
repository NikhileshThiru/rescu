/**
 * Checks the surge index against USGS high-water marks. Two questions:
 * - does it rank places by how HIGH the water rose (water-surface elevation, what surge models
 *   predict)? Depth above ground also depends on each spot's ground height, which we don't model;
 * - does it flag the places that ended up under 4+ ft of water?
 * `pnpm --filter @rescu/data surge-check`
 */
import { existsSync, readFileSync } from "node:fs";
import { sampleTrack, spearman, surgeIndex } from "@rescu/aid-model";
import { OUT_DIR, readStorms } from "./lib.js";

const pooled: { index: number; ft: number }[] = [];
const results: Record<string, { marks: number; spearman: number; deepCaught: number }> = {};
for (const storm of readStorms()) {
  const file = new URL(`hwm/${storm.slug}.csv`, OUT_DIR);
  if (!existsSync(file)) continue;
  const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = header!.split(",");
  const at = (n: string) => cols.indexOf(n);
  const marks = lines
    .map((l) => l.split(","))
    .map((f) => ({
      lat: Number(f[at("lat")]),
      lon: Number(f[at("lon")]),
      distCoastKm: Number(f[at("dist_coast_km")]),
      ft: f[at("elev_ft")] ? Number(f[at("elev_ft")]) : NaN,
      depth: f[at("height_above_ground_ft")] ? Number(f[at("height_above_ground_ft")]) : f[at("elev_ft")] ? Number(f[at("elev_ft")]) : NaN,
    }))
    .filter((m) => Number.isFinite(m.ft) && m.ft > 0 && m.ft < 40);
  if (marks.length < 25) continue;
  const index = surgeIndex(sampleTrack(storm, 600), marks);
  const deep = marks.map((m, i) => ({ ...m, index: index[i]! })).filter((m) => m.depth >= 4);
  results[storm.name] = {
    marks: marks.length,
    spearman: spearman(index, marks.map((m) => m.ft)),
    deepCaught: deep.length ? deep.filter((m) => m.index > 0.05).length / deep.length : NaN,
  };
  marks.forEach((m, i) => pooled.push({ index: index[i]!, ft: m.ft }));
}
for (const [name, r] of Object.entries(results)) {
  console.log(`${name.padEnd(9)} ${String(r.marks).padStart(4)} marks: water-height rank correlation ${r.spearman.toFixed(2)}, 4+ ft deep marks flagged ${(100 * r.deepCaught).toFixed(0)}%`);
}
console.log(`pooled ${pooled.length} marks: water-height rank correlation ${spearman(pooled.map((p) => p.index), pooled.map((p) => p.ft)).toFixed(2)}`);
