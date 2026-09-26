import { NM_PER_DEGREE_LAT } from "./geo.js";
import type { StormState } from "./types.js";
import { distanceNm } from "./geo.js";

const KM_PER_NM = 1.852;
const MM_PER_INCH = 25.4;
const MAX_RAIN_RADIUS_KM = 800;

/**
 * R-CLIPER, the rainfall climatology NHC uses as its baseline (Tuleya, DeMaria & Kuligowski
 * 2007): rain rate (inches/day) as a function of distance from the centre and max wind.
 * Rate climbs from T0 at the centre to Tm at rm, then decays exponentially with scale re.
 */
export function rainRateInPerDay(vmaxKt: number, distanceKm: number): number {
  const u = 1 + (vmaxKt - 35) / 33;
  const t0 = Math.max(0, -1.1 + 3.96 * u);
  const tm = Math.max(0, -1.6 + 4.8 * u);
  const rm = Math.max(5, 64.5 - 13 * u);
  const re = Math.max(30, 150 - 16 * u);
  if (distanceKm < rm) return t0 + ((tm - t0) * distanceKm) / rm;
  return tm * Math.exp(-(distanceKm - rm) / re);
}

/**
 * Modeled storm-total rain (inches) at each point, for storms with no observations (drawn
 * storms). Slow storms rain longer on the same place, so they total more. `scale` is the bias
 * correction fitted against PRISM observations on past storms.
 */
export function modeledRainIn(states: StormState[], points: { lat: number; lon: number }[], scale = 1): Float64Array {
  const out = new Float64Array(points.length);
  if (states.length < 2) return out;
  const dtDays = (states[1]!.t - states[0]!.t) / 86_400;
  const reachNm = MAX_RAIN_RADIUS_KM / KM_PER_NM;
  for (const s of states) {
    const kx = NM_PER_DEGREE_LAT * Math.cos((s.lat * Math.PI) / 180);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const dy = (p.lat - s.lat) * NM_PER_DEGREE_LAT;
      if (Math.abs(dy) > reachNm) continue;
      const dx = (p.lon - s.lon) * kx;
      if (dx * dx + dy * dy > reachNm * reachNm) continue;
      const dKm = distanceNm(s.lat, s.lon, p.lat, p.lon) * KM_PER_NM;
      out[i] = out[i]! + rainRateInPerDay(s.vmax, dKm) * dtDays;
    }
  }
  if (scale !== 1) for (let i = 0; i < out.length; i++) out[i] = out[i]! * scale;
  return out;
}

export const mmToIn = (mm: number) => mm / MM_PER_INCH;
