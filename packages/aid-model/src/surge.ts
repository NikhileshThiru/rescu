import { bearingDeg, distanceNm, NM_PER_DEGREE_LAT } from "./geo.js";
import type { StormState } from "./types.js";
import { reachNm, windAtPolar } from "./wind.js";

/** Surge only reaches low land near the coast; exposure halves roughly every 7 km inland. */
export const SURGE_DECAY_KM = 10;
export const SURGE_MAX_INLAND_KM = 50;

export interface CoastalPoint {
  lat: number;
  lon: number;
  distCoastKm: number;
}

/** Direction the storm is moving at state i (degrees clockwise from north). */
function heading(states: StormState[], i: number): number {
  const a = states[Math.max(0, i - 1)]!;
  const b = states[Math.min(states.length - 1, i + 1)]!;
  return bearingDeg(a.lat, a.lon, b.lat, b.lon);
}

/**
 * Storm-surge index per point (0 = none; ~1 = hurricane-force surge on the coast; ~4 = a Cat 4-5
 * eyewall pushing water ashore). Surge piles up where wind blows water onto land: the right side
 * of the track (northern hemisphere), close to the coast, scaling with wind squared (wind stress).
 * A physics-lite stand-in for NOAA's SLOSH model, checked against USGS high-water marks.
 */
export function surgeIndex(states: StormState[], points: CoastalPoint[]): Float64Array {
  const out = new Float64Array(points.length);
  const coastal = points.map((p, i) => ({ p, i })).filter(({ p }) => p.distCoastKm <= SURGE_MAX_INLAND_KM);
  states.forEach((s, k) => {
    if (s.vmax < 34) return;
    const reach = reachNm(s, 34) * 1.02 + 1;
    const kx = NM_PER_DEGREE_LAT * Math.cos((s.lat * Math.PI) / 180);
    const dir = heading(states, k);
    for (const { p, i } of coastal) {
      const dy = (p.lat - s.lat) * NM_PER_DEGREE_LAT;
      if (Math.abs(dy) > reach) continue;
      const dx = (p.lon - s.lon) * kx;
      if (dx * dx + dy * dy > reach * reach) continue;
      const d = distanceNm(s.lat, s.lon, p.lat, p.lon);
      const b = bearingDeg(s.lat, s.lon, p.lat, p.lon);
      const kt = windAtPolar(s, d, b);
      if (kt < 34) continue;
      const rightOfTrack = (1 + Math.sin(((b - dir) * Math.PI) / 180)) / 2;
      const v = (kt / 64) ** 2 * rightOfTrack * Math.exp(-p.distCoastKm / SURGE_DECAY_KM);
      if (v > out[i]!) out[i] = v;
    }
  });
  return out;
}
