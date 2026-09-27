import { aidArrival, mainLandfall } from "@rescu/live";
import { cellToLatLng } from "h3-js";
import type { HexColumns, StormFile } from "./storm-data";
import { AID_STOPS, ramp, type RGB, WIND_STOPS } from "./tokens";

const HIDDEN_BEFORE = 2 * 3600;
/** Aid columns rise over this much sim time once the storm reaches a hex. */
const AID_RISE = 4 * 3600;
/** Meters of column height for the strongest wind / biggest aid hex, per resolution. */
const HEIGHT: Record<number, { wind: number; aid: number }> = {
  4: { wind: 110_000, aid: 150_000 },
  5: { wind: 55_000, aid: 85_000 },
};

/**
 * Per-hex colour and height for one storm at one resolution, recomputed each frame into typed
 * arrays that deck.gl reads by index. Wind builds up as the storm passes (each hex follows its own
 * arrival times for 34/50/64 kt and peak), aid is the allocation, and `mix` blends the two so
 * switching layers morphs instead of snapping.
 */
export class HexField {
  readonly n: number;
  readonly h3: string[];
  readonly res: number;
  readonly cols: HexColumns;
  /** Keyframes per hex: [time, kt] pairs, flattened, up to 5 per hex. */
  private keyT: Float64Array;
  private keyV: Float32Array;
  private keyN: Uint8Array;
  private aidColor: Uint8Array;
  private aidHeight: Float32Array;
  private hasAid: Uint8Array;
  /** When each hex's aid lands (unix s): the storm's arrival there, never before it hits. */
  readonly aidAt: Float64Array;
  /** 0..1 how far each hex's aid column has risen at the last update. */
  readonly aidNow: Float32Array;
  /** 0.35 outside the focus region, 1 inside, feathered between. */
  readonly focus: Float32Array;
  readonly color: Uint8Array;
  readonly height: Float32Array;
  readonly windNow: Float32Array;
  readonly centers: Float64Array;

  constructor(file: StormFile, res: number) {
    const c = file.hexes[res];
    if (!c) throw new Error(`no res ${res} hexes`);
    this.cols = c;
    this.res = res;
    this.h3 = c.h3;
    const n = (this.n = c.h3.length);
    const t0 = file.trackStart;
    const abs = (m: number) => (m < 0 ? -1 : t0 + m * 60);

    this.keyT = new Float64Array(n * 5);
    this.keyV = new Float32Array(n * 5);
    this.keyN = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const kt = c.kt[i]!;
      const peak = abs(c.peak[i]!);
      const frames: [number, number][] = [];
      const t34 = abs(c.t34[i]!);
      const first = t34 >= 0 ? t34 : peak;
      if (first >= 0) frames.push([first - HIDDEN_BEFORE, 0]);
      for (const [t, v] of [
        [t34, 34],
        [abs(c.t50[i]!), 50],
        [abs(c.t64[i]!), 64],
      ] as const) {
        if (t >= 0 && v <= kt) frames.push([t, v]);
      }
      if (peak >= 0) frames.push([peak, kt]);
      frames.sort((a, b) => a[0] - b[0]);
      let last = -Infinity;
      let k = 0;
      for (const [t, v] of frames) {
        if (t <= last || k >= 5) continue;
        this.keyT[i * 5 + k] = t;
        this.keyV[i * 5 + k] = Math.max(v, k ? this.keyV[i * 5 + k - 1]! : 0);
        last = t;
        k++;
      }
      this.keyN[i] = k;
    }

    const landfall = mainLandfall(file.storm).t;
    this.aidAt = new Float64Array(n);
    this.aidNow = new Float32Array(n);
    for (let i = 0; i < n; i++) this.aidAt[i] = aidArrival(abs(c.t34[i]!), abs(c.peak[i]!), landfall);

    const h = HEIGHT[res] ?? HEIGHT[5]!;
    let maxAid = 1;
    for (let i = 0; i < n; i++) maxAid = Math.max(maxAid, c.aid[i]!);
    this.aidColor = new Uint8Array(n * 3);
    this.aidHeight = new Float32Array(n);
    this.hasAid = new Uint8Array(n);
    const rgb: RGB = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (c.aid[i]! <= 0) continue;
      this.hasAid[i] = 1;
      ramp(AID_STOPS, c.aid[i]! / Math.max(1, c.eligible[i]!), rgb);
      this.aidColor.set(rgb, i * 3);
      this.aidHeight[i] = 2_000 + Math.sqrt(c.aid[i]! / maxAid) * h.aid;
    }

    this.centers = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const [lat, lon] = cellToLatLng(c.h3[i]!);
      this.centers[i * 2] = lon;
      this.centers[i * 2 + 1] = lat;
    }
    this.focus = new Float32Array(n);
    const rings = file.focus.rings;
    for (let i = 0; i < n; i++) {
      const lon = this.centers[i * 2]!;
      const lat = this.centers[i * 2 + 1]!;
      let inside = 0;
      for (const r of rings) if (pointInRing(lon, lat, r)) inside++;
      this.focus[i] = 0.3 + (0.7 * inside) / rings.length;
    }

    this.color = new Uint8Array(n * 4);
    this.height = new Float32Array(n);
    this.windNow = new Float32Array(n);
    this.windMaxHeight = h.wind;
  }

  private windMaxHeight: number;

  /** Wind a hex has seen so far at time t (kt), following its arrival keyframes. */
  windAt(i: number, t: number): number {
    const k = this.keyN[i]!;
    if (!k) return 0;
    const o = i * 5;
    if (t <= this.keyT[o]!) return 0;
    for (let j = 1; j < k; j++) {
      const tj = this.keyT[o + j]!;
      if (t <= tj) {
        const t0 = this.keyT[o + j - 1]!;
        const v0 = j === 1 ? 20 : this.keyV[o + j - 1]!;
        const f = (t - t0) / (tj - t0);
        return v0 + (this.keyV[o + j]! - v0) * f;
      }
    }
    return this.keyV[o + k - 1]!;
  }

  /**
   * Fill `color` / `height` for time t. mix: 0 = wind, 1 = aid. Each aid column rises from the
   * ground when the storm reaches its hex, so aid lands behind the storm instead of all at once.
   */
  update(t: number, mix: number) {
    const wind: RGB = [0, 0, 0];
    const n = this.n;
    const hw = this.windMaxHeight;
    for (let i = 0; i < n; i++) {
      const kt = this.windAt(i, t);
      this.windNow[i] = kt;
      let wr = 0,
        wg = 0,
        wb = 0,
        wa = 0,
        we = 0;
      if (kt > 20) {
        ramp(WIND_STOPS, kt, wind);
        [wr, wg, wb] = wind;
        const s = Math.min(1, (kt - 20) / 110);
        wa = (45 + 190 * Math.min(1, (kt - 20) / 60)) * Math.min(1, (kt - 20) / 3);
        we = 800 + hw * s ** 1.35;
      }
      let ar = 0,
        ag = 0,
        ab = 0,
        aa = 0,
        ae = 0;
      if (this.hasAid[i]) {
        const x = Math.min(1, Math.max(0, (t - this.aidAt[i]!) / AID_RISE));
        const rise = x * x * (3 - 2 * x);
        this.aidNow[i] = rise;
        ar = this.aidColor[i * 3]!;
        ag = this.aidColor[i * 3 + 1]!;
        ab = this.aidColor[i * 3 + 2]!;
        aa = 235 * Math.min(1, rise * 3);
        ae = this.aidHeight[i]! * rise;
      } else {
        // Keep the colour of fading wind cells instead of tinting them black.
        ar = wr;
        ag = wg;
        ab = wb;
      }
      const f = this.focus[i]!;
      const r = wr + (ar - wr) * mix;
      const g = wg + (ag - wg) * mix;
      const b = wb + (ab - wb) * mix;
      const o = i * 4;
      // Outside the focus region hexes fade out rather than darken, so they never smudge the land.
      this.color[o] = r;
      this.color[o + 1] = g;
      this.color[o + 2] = b;
      this.color[o + 3] = (wa + (aa - wa) * mix) * (0.08 + 0.92 * f);
      this.height[i] = we + (ae - we) * mix;
    }
  }

  visible(i: number): boolean {
    return this.color[i * 4 + 3]! > 8;
  }
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
