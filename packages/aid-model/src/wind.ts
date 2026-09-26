import { bearingDeg, destination, distanceNm, NM_PER_DEGREE_LAT } from "./geo";
import { type Band, bandOf, type Impact, type Radii, type StormState } from "./types";

/** Outside the outermost reported radius wind falls off as (r/d)^DECAY (modified Rankine). */
const DECAY = 0.6;
/** Winds below this aren't tracked at all (the map's faintest shade). */
export const MIN_TRACKED_KT = 20;

/**
 * Reported radius at an arbitrary bearing. HURDAT gives one value per quadrant; treating each
 * as a constant pie slice draws pinwheel artifacts, so each value sits at its quadrant's
 * centre bearing (45, 135, 225, 315) and neighbours blend linearly.
 */
export function radiusAtBearing(r: [number, number, number, number], bearing: number): number {
  const shifted = (((bearing - 45) % 360) + 360) % 360;
  const i = Math.floor(shifted / 90);
  const f = (shifted - i * 90) / 90;
  return r[i]! * (1 - f) + r[(i + 1) % 4]! * f;
}

type Anchor = [radiusNm: number, kt: number];

/** Piecewise-linear wind profile along one bearing, anchored at the RMW and each reported isotach. */
function profile(s: StormState, bearing: number): Anchor[] {
  let cap = s.vmax;
  const isotachs: [Radii, number][] = [
    [s.r34, 34],
    [s.r50, 50],
    [s.r64, 64],
  ];
  // If NHC reports no 34/50/64 kt winds in this direction, the core can't exceed that there.
  for (const [r, kt] of isotachs) {
    if (!r || s.vmax <= kt) continue;
    if (radiusAtBearing(r, bearing) <= 0) {
      cap = Math.min(cap, kt - 1);
      break;
    }
  }
  const raw: Anchor[] = [[s.rmw, cap]];
  for (const [r, kt] of [...isotachs].reverse()) {
    if (!r || cap <= kt) continue;
    const radius = radiusAtBearing(r, bearing);
    if (radius > 0) raw.push([radius, kt]);
  }
  // Wind must fall with distance: drop inner anchors that sit outside an outer isotach.
  const out: Anchor[] = [];
  for (const a of raw) {
    while (out.length && out[out.length - 1]![0] >= a[0]) out.pop();
    out.push(a);
  }
  return out;
}

/** Estimated max sustained wind (kt) at distance `d` nm and `bearing` from the centre. */
export function windAtPolar(s: StormState, d: number, bearing: number): number {
  if (s.vmax <= 0) return 0;
  const p = profile(s, bearing);
  const first = p[0]!;
  if (d <= first[0]) return first[1];
  // Between anchors wind decays as a power of distance (straight lines in log-log), the shape
  // real outer-core profiles follow; linear interpolation holds winds up far too long.
  for (let i = 1; i < p.length; i++) {
    const [r1, w1] = p[i - 1]!;
    const [r2, w2] = p[i]!;
    if (d <= r2) return w1 * (d / r1) ** (Math.log(w2 / w1) / Math.log(r2 / r1));
  }
  const [rl, wl] = p[p.length - 1]!;
  return wl * (rl / d) ** DECAY;
}

export function windAt(s: StormState, lat: number, lon: number): number {
  const d = distanceNm(s.lat, s.lon, lat, lon);
  return windAtPolar(s, d, bearingDeg(s.lat, s.lon, lat, lon));
}

/** Farthest distance (nm) at which this state can produce `kt`. Used to skip far points cheaply. */
export function reachNm(s: StormState, kt = MIN_TRACKED_KT): number {
  if (s.vmax < kt) return 0;
  const outer = s.r34 ? Math.max(...s.r34) : 0;
  const [r, w] = outer > 0 && s.vmax > 34 ? [outer, 34] : [s.rmw, s.vmax];
  return w <= kt ? r : r * (w / kt) ** (1 / DECAY);
}

/**
 * Peak wind, band and arrival times at each point over the whole storm. The states should be
 * dense (see `sampleTrack`); every point is checked against every state inside its reach.
 */
export function impactsAt(states: StormState[], points: { lat: number; lon: number }[]): Impact[] {
  const out: Impact[] = points.map(() => ({ maxKt: 0, band: 0, peakT: null, t34: null, t50: null, t64: null }));
  for (const s of states) {
    const reach = reachNm(s) * 1.02 + 1;
    if (reach <= 1) continue;
    const reach2 = reach * reach;
    const kx = NM_PER_DEGREE_LAT * Math.cos((s.lat * Math.PI) / 180);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      const dy = (p.lat - s.lat) * NM_PER_DEGREE_LAT;
      if (dy * dy > reach2) continue;
      const dx = (p.lon - s.lon) * kx;
      if (dx * dx + dy * dy > reach2) continue;
      const kt = windAt(s, p.lat, p.lon);
      if (kt < MIN_TRACKED_KT) continue;
      const imp = out[i]!;
      if (kt > imp.maxKt) {
        imp.maxKt = kt;
        imp.peakT = s.t;
      }
      if (kt >= 34 && imp.t34 === null) imp.t34 = s.t;
      if (kt >= 50 && imp.t50 === null) imp.t50 = s.t;
      if (kt >= 64 && imp.t64 === null) imp.t64 = s.t;
    }
  }
  for (const imp of out) imp.band = bandOf(imp.maxKt) as Band;
  return out;
}

/**
 * Outline of the reported `kt` wind radius (34, 50 or 64) as a closed [lon, lat] ring, for
 * drawing the storm's wind rings. Lopsided on purpose: it follows NHC's quadrant radii.
 */
export function isotachRing(s: StormState, kt: 34 | 50 | 64, steps = 96): [number, number][] | null {
  const r = kt === 34 ? s.r34 : kt === 50 ? s.r50 : s.r64;
  if (!r || s.vmax < kt || Math.max(...r) <= 0) return null;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = (i * 360) / steps;
    const [lat, lon] = destination(s.lat, s.lon, bearing, radiusAtBearing(r, bearing));
    ring.push([lon, lat]);
  }
  return ring;
}
