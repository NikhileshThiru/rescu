import { KM_PER_NM } from "./geo";
import type { Quadrants, Radii, Storm, StormPoint, StormState } from "./types";

const KT_TO_MS = 0.514444;

/**
 * Radius of maximum wind when the best track doesn't report it (before 2021, e.g. Katrina).
 * Willoughby, Darling & Rahn (2006): Rmax[km] = 46.4 exp(-0.0155 Vmax[m/s] + 0.0169 |lat|).
 */
export function estimateRmwNm(vmaxKt: number, lat: number): number {
  const km = 46.4 * Math.exp(-0.0155 * vmaxKt * KT_TO_MS + 0.0169 * Math.abs(lat));
  return km / KM_PER_NM;
}

function radii(q: Quadrants): Radii {
  if (q.every((r) => r === null)) return null;
  return q.map((r) => r ?? 0) as [number, number, number, number];
}

function lerp(a: number, b: number, f: number) {
  return a + (b - a) * f;
}

function lerpRadii(a: Radii, b: Radii, f: number): Radii {
  if (!a) return b;
  if (!b) return a;
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f)];
}

function rmwOf(p: StormPoint) {
  return p.rmw ?? estimateRmwNm(p.vmax ?? 0, p.lat);
}

export function stormTimeRange(storm: Storm): [number, number] {
  return [storm.points[0]!.t, storm.points[storm.points.length - 1]!.t];
}

/** The storm at time `t` (linear between best-track fixes), or null outside the track. */
export function stormState(storm: Storm, t: number): StormState | null {
  const pts = storm.points;
  if (pts.length === 0 || t < pts[0]!.t || t > pts[pts.length - 1]!.t) return null;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[hi]!;
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return {
    t,
    lat: lerp(a.lat, b.lat, f),
    lon: lerp(a.lon, b.lon, f),
    vmax: lerp(a.vmax ?? 0, b.vmax ?? 0, f),
    rmw: lerp(rmwOf(a), rmwOf(b), f),
    r34: lerpRadii(radii(a.r34), radii(b.r34), f),
    r50: lerpRadii(radii(a.r50), radii(b.r50), f),
    r64: lerpRadii(radii(a.r64), radii(b.r64), f),
  };
}

/** Storm states every `stepSec` over the whole track (10 min keeps the eyewall swath gap-free). */
export function sampleTrack(storm: Storm, stepSec = 600): StormState[] {
  const [t0, t1] = stormTimeRange(storm);
  const out: StormState[] = [];
  for (let t = t0; t < t1; t += stepSec) out.push(stormState(storm, t)!);
  out.push(stormState(storm, t1)!);
  return out;
}
