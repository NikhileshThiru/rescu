/**
 * Map data for the web app: one file per demo storm with the best track, the wind field and the
 * aid allocation on H3 at every display resolution, county totals next to FEMA's, and the
 * focus region the camera flies to. Same model and rules as `pnpm data:report`.
 * `pnpm --filter @rescu/data export-web` (after data:features and data:fit)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { latLngToCell } from "h3-js";
import {
  allocate,
  autoDeclareCounties,
  DEFAULT_NEED_MODEL,
  destination,
  distributionOverlap,
  dominantHazard,
  need,
  summarize,
  tractTotalCents,
  windHexes,
} from "@rescu/aid-model";
import { OUT_DIR, readFema, readStorms, readTracts, REPO_ROOT, runStorm } from "./lib.js";

const RESOLUTIONS = [4, 5];
/** The wind layer's faintest shade; weaker cells only add noise over open water. */
const MIN_MAP_KT = 25;
/** Feathered focus mask: nested buffers around the aid area, km. */
const FOCUS_BUFFERS_KM = [30, 55, 80, 110, 145];
const HAZARDS = ["none", "wind", "rain", "surge"] as const;

const WEB_DATA = new URL("apps/web/public/data/", REPO_ROOT);
mkdirSync(WEB_DATA, { recursive: true });

const model = JSON.parse(readFileSync(new URL("need-model.json", OUT_DIR), "utf8"));
const tracts = readTracts();
const byGeoid = new Map(tracts.map((t, i) => [t.geoid, i]));
const fema = readFema();

const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

/** Andrew's monotone chain on [x, y] points. */
function convexHull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Convex hull of the points grown by `km` in every direction, as a closed [lon, lat] ring. */
function bufferedHull(lonLat: [number, number][], km: number): [number, number][] {
  const hull = convexHull(lonLat);
  const around: [number, number][] = [];
  for (const [lon, lat] of hull) {
    for (let b = 0; b < 360; b += 10) {
      const [la, lo] = destination(lat, lon, b, km / 1.852);
      around.push([lo, la]);
    }
  }
  const ring = convexHull(around).map(([lo, la]) => [round(lo, 3), round(la, 3)] as [number, number]);
  return [...ring, ring[0]!];
}

for (const storm of readStorms().filter((s) => s.demo)) {
  const t0 = performance.now();
  const f = fema[storm.id]!;
  const [, ...lines] = readFileSync(new URL(`features/${storm.slug}.csv`, OUT_DIR), "utf8").trim().split(/\r?\n/);

  const needBy = new Float64Array(tracts.length);
  const windBy = new Float32Array(tracts.length);
  const rainBy = new Float32Array(tracts.length);
  const surgeBy = new Float32Array(tracts.length);
  const hazardBy: string[] = new Array(tracts.length).fill("none");
  for (const l of lines) {
    const x = l.split(",");
    const i = byGeoid.get(x[0]!);
    if (i === undefined) continue;
    const h = { windKt: Number(x[1]), rainIn: Number(x[5]), surge: Number(x[7]), mobileShare: (tracts[i]!.pctMobileHome ?? 0) / 100 };
    needBy[i] = need(h);
    windBy[i] = h.windKt;
    rainBy[i] = h.rainIn;
    surgeBy[i] = h.surge;
    hazardBy[i] = dominantHazard(h, DEFAULT_NEED_MODEL.params);
  }
  const declared = autoDeclareCounties(tracts, needBy, DEFAULT_NEED_MODEL.declareThreshold);
  const inputs = tracts.map((t, i) => ({ households: t.households, svi: t.svi, need: needBy[i]!, declared: declared.has(t.countyFips) }));
  const alloc = allocate(inputs);
  const summary = summarize(inputs, alloc, hazardBy);

  // Counties: everything the storm touched or FEMA paid, so the rail can compare the two.
  interface County { fips: string; name: string; state: string; households: number; expectedNeed: number; eligible: number; aidCents: number }
  const counties = new Map<string, County>();
  tracts.forEach((t, i) => {
    if (needBy[i]! <= 0 && !f.ihp[t.countyFips]) return;
    let c = counties.get(t.countyFips);
    if (!c) {
      c = { fips: t.countyFips, name: t.countyName, state: t.stateAbbr, households: 0, expectedNeed: 0, eligible: 0, aidCents: 0 };
      counties.set(t.countyFips, c);
    }
    c.households += t.households;
    c.expectedNeed += t.households * needBy[i]!;
    if (alloc.score[i]! > 0) {
      c.eligible += t.households;
      c.aidCents += tractTotalCents(alloc, i, t.households);
    }
  });
  const countyList = [...counties.values()]
    .filter((c) => c.aidCents > 0 || (f.ihp[c.fips]?.approved ?? 0) > 0 || c.expectedNeed / c.households >= 0.002)
    .sort((a, b) => b.aidCents - a.aidCents || b.expectedNeed - a.expectedNeed);
  const countyIndex = new Map(countyList.map((c, i) => [c.fips, i]));

  // Hexes: wind field (land and sea) joined with the tract allocation (land).
  const { states } = runStorm(storm, []);
  const trackStart = storm.points[0]!.t;
  const minutes = (t: number | null) => (t === null ? -1 : Math.round((t - trackStart) / 60));
  const hexes: Record<string, unknown> = {};
  for (const res of RESOLUTIONS) {
    interface Cell {
      kt: number; t34: number; t50: number; t64: number; peak: number;
      hh: number; elig: number; aidCents: number; expected: number;
      rainW: number; surgeMax: number; hazardAid: number[]; sviW: number; countyHh: Map<string, number>;
    }
    const cells = new Map<string, Cell>();
    const blank = (): Cell => ({ kt: 0, t34: -1, t50: -1, t64: -1, peak: -1, hh: 0, elig: 0, aidCents: 0, expected: 0, rainW: 0, surgeMax: 0, hazardAid: [0, 0, 0, 0], sviW: 0, countyHh: new Map() });
    for (const w of windHexes(states, res, MIN_MAP_KT)) {
      cells.set(w.h3, { ...blank(), kt: w.maxKt, t34: minutes(w.t34), t50: minutes(w.t50), t64: minutes(w.t64), peak: minutes(w.peakT) });
    }
    // Every tract inside the storm's wind field counts toward its hex (so "households" and
    // "need %" describe the whole hex, not only the tracts with some need); outside it, only
    // tracts with need (e.g. rain-only areas) create a hex.
    tracts.forEach((t, i) => {
      if (t.households <= 0) return;
      const h3 = latLngToCell(t.lat, t.lon, res);
      let c = cells.get(h3);
      if (!c) {
        if (needBy[i]! <= 0) return;
        c = blank();
        cells.set(h3, c);
      }
      c.kt = Math.max(c.kt, windBy[i]!);
      c.hh += t.households;
      c.expected += t.households * needBy[i]!;
      c.rainW += t.households * rainBy[i]!;
      c.sviW += t.households * t.svi;
      c.surgeMax = Math.max(c.surgeMax, surgeBy[i]!);
      c.countyHh.set(t.countyFips, (c.countyHh.get(t.countyFips) ?? 0) + t.households);
      if (alloc.score[i]! > 0) {
        const cents = tractTotalCents(alloc, i, t.households);
        c.elig += t.households;
        c.aidCents += cents;
        c.hazardAid[HAZARDS.indexOf(hazardBy[i] as (typeof HAZARDS)[number])]! += cents;
      }
    });
    const list = [...cells.entries()].filter(([, c]) => c.kt >= MIN_MAP_KT || c.aidCents > 0 || c.expected / Math.max(1, c.hh) >= 0.005);
    const col = <T>(fn: (c: Cell) => T) => list.map(([, c]) => fn(c));
    hexes[res] = {
      h3: list.map(([h]) => h),
      kt: col((c) => round(c.kt)),
      t34: col((c) => c.t34),
      t50: col((c) => c.t50),
      t64: col((c) => c.t64),
      peak: col((c) => c.peak),
      households: col((c) => c.hh),
      eligible: col((c) => c.elig),
      aid: col((c) => Math.round(c.aidCents / 100)),
      needPct: col((c) => (c.hh ? round((100 * c.expected) / c.hh, 1) : 0)),
      rainIn: col((c) => (c.hh ? round(c.rainW / c.hh, 1) : 0)),
      surge: col((c) => round(c.surgeMax, 2)),
      svi: col((c) => (c.hh ? round(c.sviW / c.hh, 2) : 0)),
      hazard: col((c) => {
        const best = c.hazardAid.indexOf(Math.max(...c.hazardAid));
        return c.aidCents > 0 ? best : 0;
      }),
      county: col((c) => {
        let best = -1;
        let most = 0;
        for (const [fips, hh] of c.countyHh) if (hh > most && countyIndex.has(fips)) [best, most] = [countyIndex.get(fips)!, hh];
        return best;
      }),
    };
  }

  const eligiblePts: [number, number][] = [];
  tracts.forEach((t, i) => {
    if (alloc.score[i]! > 0) eligiblePts.push([t.lon, t.lat]);
  });
  const lons = eligiblePts.map((p) => p[0]);
  const lats = eligiblePts.map((p) => p[1]);
  const focusBounds = [
    [round(Math.min(...lons), 2), round(Math.min(...lats), 2)],
    [round(Math.max(...lons), 2), round(Math.max(...lats), 2)],
  ];

  const femaApproved = Object.values(f.ihp).reduce((x, c) => x + c.approved, 0);
  const femaUsd = Object.values(f.ihp).reduce((x, c) => x + c.amount, 0);
  const captured = [...declared].reduce((x, c) => x + (f.ihp[c]?.approved ?? 0), 0);
  const allFips = [...new Set([...countyList.map((c) => c.fips), ...Object.keys(f.ihp)])];
  const payoutOverlap = distributionOverlap(
    allFips.map((c) => (counties.get(c)?.aidCents ?? 0) * (declared.has(c) ? 1 : 0)),
    allFips.map((c) => f.ihp[c]?.approved ?? 0),
  );
  const v = model.validation?.[storm.slug];
  const eligibleStates = new Set(tracts.filter((_, i) => alloc.score[i]! > 0).map((t) => t.stateAbbr));

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    storm: { id: storm.id, slug: storm.slug, name: storm.name, year: storm.year, points: storm.points, landfalls: storm.landfalls },
    trackStart,
    hazards: HAZARDS,
    projection: {
      eligibleHouseholds: summary.eligibleHouseholds,
      potUsd: summary.potUsd,
      minAidUsd: summary.minAidUsd,
      maxAidUsd: summary.maxAidUsd,
      medianAidUsd: summary.medianAidUsd,
      declaredCounties: declared.size,
      states: [...eligibleStates].sort(),
      byHazard: summary.byGroup,
    },
    fema: {
      approvedHouseholds: femaApproved,
      approvedUsd: Math.round(femaUsd),
      designatedCounties: f.iaCounties.length,
      designatedDeclared: f.iaCounties.filter((c) => declared.has(c)).length,
      capturedShare: femaApproved ? round(captured / femaApproved, 3) : null,
      payoutOverlap: round(payoutOverlap, 3),
      heldOutOverlap: v ? round(v.scores.hazard.overlap, 3) : null,
      specRuleOverlap: v ? round(v.scores.specRule.overlap, 3) : null,
    },
    counties: countyList.map((c) => ({
      fips: c.fips,
      name: c.name,
      state: c.state,
      households: c.households,
      needPct: round((100 * c.expectedNeed) / c.households, 2),
      declared: declared.has(c.fips),
      eligible: c.eligible,
      aidUsd: Math.round(c.aidCents / 100),
      femaApproved: f.ihp[c.fips]?.approved ?? 0,
      femaDesignated: f.iaCounties.includes(c.fips),
    })),
    focus: { bounds: focusBounds, rings: FOCUS_BUFFERS_KM.map((km) => bufferedHull(eligiblePts, km)) },
    hexes,
  };
  const json = JSON.stringify(out);
  writeFileSync(new URL(`${storm.slug}.json`, WEB_DATA), json);
  const counts = RESOLUTIONS.map((r) => `${(hexes[r] as { h3: string[] }).h3.length.toLocaleString()} res-${r}`).join(", ");
  console.log(
    `${storm.name} ${storm.year}: ${counts} hexes, ${countyList.length} counties, ${(json.length / 1e6).toFixed(2)} MB ` +
      `(${Math.round(performance.now() - t0)} ms)`,
  );
}

writeFileSync(
  new URL("storms.json", WEB_DATA),
  JSON.stringify(readStorms().filter((s) => s.demo).map((s) => ({ slug: s.slug, name: s.name, year: s.year }))),
);
