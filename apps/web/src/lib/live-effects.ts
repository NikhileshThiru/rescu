import type { LiveBatch, MerchantDot } from "@rescu/live";
import { cellToLatLng } from "h3-js";
import type { LiveClient } from "./live";

/** Seconds a purchase takes to fly from a home to the store, and how long its trail lingers. */
export const ARC_FLIGHT = 0.9;
export const ARC_TRAIL = 0.5;
const ARC_SEGMENTS = 14;
const ARC_MAX = 360;
const PULSE_MAX = 700;
/** Batches arrive every 250 ms; spread each one's effects across that window so they don't pop in sync. */
const SPREAD = 0.25;
/**
 * Most trips are a few km, a pixel or two at region zoom, so an arc is at least this many screen
 * pixels tall at the zoom it was born: a visible hop even when home and store share a pixel.
 */
const ARC_MIN_PX = 9;
const ARC_MAX_M = 60_000;

export interface Arc {
  path: [number, number, number][];
  times: number[];
  ok: boolean;
}

type RGB = [number, number, number];

interface Pulse {
  lon: number;
  lat: number;
  born: number;
  life: number;
  r0: number;
  r1: number;
  width: number;
  color: RGB;
  alpha: number;
}

export interface PulseView {
  position: [number, number];
  radius: number;
  width: number;
  color: [number, number, number, number];
}

const AID: RGB = [45, 212, 191];
const PAID: RGB = [214, 246, 240];
const BLOCKED: RGB = [240, 97, 109];

function meters(a: [number, number], b: [number, number]) {
  const k = 111_320;
  const dx = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) * Math.PI) / 360);
  const dy = (b[1] - a[1]) * k;
  return Math.hypot(dx, dy);
}

/**
 * Turns the live network's batches into things the map can draw cheaply: purchase arcs (animated
 * on the GPU by TripsLayer from one time uniform) and a small pool of expanding rings for aid
 * landing, purchases arriving and blocked payments. Times are page seconds (performance.now).
 */
export class LiveEffects {
  /** Storm on screen; effects and stores only show for the run of this storm. */
  slug: string | null = null;
  /** Map zoom, kept current by the map's frame loop. */
  zoom = 5;
  private arcs: Arc[] = [];
  private pulses: Pulse[] = [];
  private centers = new Map<string, [number, number]>();
  private lastPrune = 0;

  constructor(private readonly live: LiveClient) {}

  /** Start listening to batches; returns the unsubscribe. */
  attach() {
    return this.live.onBatch((b) => this.add(b, performance.now() / 1000));
  }

  get active(): boolean {
    const r = this.live.state.run;
    return !!r && r.slug === this.slug && (r.phase === "ready" || r.phase === "live" || r.phase === "ended");
  }

  /** The run's stores, while it's the storm on screen. */
  merchants(): MerchantDot[] | null {
    const { run, merchants } = this.live.state;
    return this.active && merchants && run && merchants.runId === run.id ? merchants.list : null;
  }

  clear() {
    this.arcs = [];
    this.pulses = [];
  }

  private add(batch: LiveBatch, now: number) {
    if (!this.active) return;
    for (const a of batch.aid) {
      let c = this.centers.get(a.h3);
      if (!c) {
        const [lat, lon] = cellToLatLng(a.h3);
        c = [lon, lat];
        this.centers.set(a.h3, c);
      }
      this.pulse({
        lon: c[0],
        lat: c[1],
        born: now + Math.random() * SPREAD,
        life: 1.4,
        r0: 3,
        r1: 10 + 3.2 * Math.log2(1 + a.households),
        width: 1.5,
        color: AID,
        alpha: 235,
      });
    }

    const arcs = this.prune(now);
    const perPx = 156_543 / 2 ** this.zoom;
    for (const p of batch.pays) {
      const born = now + Math.random() * SPREAD;
      const d = meters(p.from, p.to);
      let lands = born;
      if (d > 300) {
        const floor = ARC_MIN_PX * perPx * Math.cos((p.to[1] * Math.PI) / 180);
        const h = Math.min(ARC_MAX_M, Math.max(floor, d * 0.35));
        const path: [number, number, number][] = [];
        const times: number[] = [];
        for (let i = 0; i <= ARC_SEGMENTS; i++) {
          const s = i / ARC_SEGMENTS;
          path.push([p.from[0] + (p.to[0] - p.from[0]) * s, p.from[1] + (p.to[1] - p.from[1]) * s, h * 4 * s * (1 - s)]);
          times.push(born + ARC_FLIGHT * s);
        }
        arcs.push({ path, times, ok: p.ok });
        lands = born + ARC_FLIGHT;
      }
      this.pulse(
        p.ok
          ? { lon: p.to[0], lat: p.to[1], born: lands, life: 0.8, r0: 1.5, r1: 7, width: 1, color: PAID, alpha: 210 }
          : { lon: p.to[0], lat: p.to[1], born: lands, life: 1.8, r0: 3, r1: 18, width: 2, color: BLOCKED, alpha: 255 },
      );
    }
    this.arcs = arcs.length > ARC_MAX ? arcs.slice(arcs.length - ARC_MAX) : arcs;
  }

  /** Arcs still in flight or trailing. Same array between batches, so deck.gl keeps its buffers. */
  arcsAt(now: number): Arc[] {
    if (now - this.lastPrune > 0.5 && this.arcs.length && this.arcs[0]!.times[ARC_SEGMENTS]! + ARC_TRAIL < now) {
      this.arcs = this.prune(now);
    }
    return this.arcs;
  }

  /** Rings at this instant (a fresh array every frame; a few hundred at most). */
  pulsesAt(now: number): PulseView[] {
    const out: PulseView[] = [];
    let keep = 0;
    for (const p of this.pulses) {
      const age = (now - p.born) / p.life;
      if (age >= 1) continue;
      this.pulses[keep++] = p;
      if (age < 0) continue;
      const e = 1 - (1 - age) ** 3;
      out.push({
        position: [p.lon, p.lat],
        radius: p.r0 + (p.r1 - p.r0) * e,
        width: p.width,
        color: [p.color[0], p.color[1], p.color[2], p.alpha * (1 - age) ** 1.4],
      });
    }
    this.pulses.length = keep;
    return out;
  }

  private prune(now: number): Arc[] {
    this.lastPrune = now;
    return this.arcs.filter((a) => a.times[ARC_SEGMENTS]! + ARC_TRAIL >= now);
  }

  private pulse(p: Pulse) {
    if (this.pulses.length >= PULSE_MAX) this.pulses.splice(0, this.pulses.length - PULSE_MAX + 1);
    this.pulses.push(p);
  }
}
