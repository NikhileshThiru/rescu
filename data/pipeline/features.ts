/**
 * Hazard features per storm per tract: modeled peak wind (and arrival times), observed rain
 * (PRISM), modeled rain (R-CLIPER, unscaled), and the surge index. Only tracts something reached
 * are kept. Writes data/out/features/<slug>.csv. `pnpm --filter @rescu/data features`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { impactsAt, modeledRainIn, sampleTrack, surgeIndex } from "@rescu/aid-model";
import { OUT_DIR, readCoastDistance, readObservedRain, readStorms, readTracts } from "./lib.js";

const OUT = new URL("features/", OUT_DIR);
mkdirSync(OUT, { recursive: true });

const tracts = readTracts();
const coast = readCoastDistance();
const points = tracts.map((t) => ({ lat: t.lat, lon: t.lon, distCoastKm: coast.get(t.geoid) ?? 200 }));
const only = process.argv[2];

for (const storm of readStorms()) {
  if (only && storm.slug !== only) continue;
  const t0 = performance.now();
  const states = sampleTrack(storm, 600);
  const wind = impactsAt(states, points);
  const rainModel = modeledRainIn(states, points);
  const surge = surgeIndex(states, points);
  const rainObs = readObservedRain(storm.slug);

  const lines = ["geoid,wind_kt,peak_t,t34,t64,rain_obs_in,rain_model_in,surge"];
  let kept = 0;
  tracts.forEach((t, i) => {
    const obs = rainObs.get(t.geoid) ?? 0;
    const w = wind[i]!;
    if (w.maxKt < 20 && obs < 1 && rainModel[i]! < 1 && surge[i]! <= 0) return;
    kept++;
    lines.push(
      [t.geoid, w.maxKt.toFixed(1), w.peakT ?? "", w.t34 ?? "", w.t64 ?? "", obs.toFixed(2), rainModel[i]!.toFixed(2), surge[i]!.toFixed(3)].join(","),
    );
  });
  writeFileSync(new URL(`${storm.slug}.csv`, OUT), lines.join("\n") + "\n");
  console.log(`${storm.name.padEnd(9)}${storm.year}: ${kept.toLocaleString()} tracts touched (${(performance.now() - t0).toFixed(0)} ms)`);
}
