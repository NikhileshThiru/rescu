import type { LiveBatch, MerchantDot, OracleCase, Spotlight, StoreState } from "@rescu/live";
import { cellToLatLng } from "h3-js";
import { money, ruleLabel, usd } from "./format";
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

/** Spotlight (a person, an agent or the oracle did it): slower, taller, brighter arcs. */
export const SPOT_FLIGHT = 1.5;
export const SPOT_TRAIL = 1.3;
const SPOT_ARC_MIN_PX = 42;
const SPOT_ARC_MAX_M = 140_000;
const SPOT_ARC_MAX = 24;
/** Labels on the map at once; the oldest makes room. */
export const LABEL_MAX = 6;
const LABEL_LIFE = 4.6;
const SPOT_RING_MAX = 80;

export type LabelTone = "teal" | "red" | "amber";

/** A chip on the map next to something a person, an agent or the oracle just did. */
export interface SpotLabel {
  id: number;
  lon: number;
  lat: number;
  born: number;
  life: number;
  tone: LabelTone;
  text: string;
  /** Right-aligned figure: "$24.98", "+$1,000". */
  figure: string | null;
  /** Second line: "Blocked by the chain · Store suspended". */
  sub: string | null;
}

/** A store the oracle flagged (amber) or suspended (red), placed on the map. */
export interface StoreMark {
  position: [number, number];
  suspended: boolean;
  flagged: boolean;
}

export interface SpotRingView {
  position: [number, number];
  radius: number;
  width: number;
  line: [number, number, number, number];
  fill: [number, number, number, number];
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
const AMBER: RGB = [245, 184, 61];

interface SpotRing {
  lon: number;
  lat: number;
  born: number;
  life: number;
  r0: number;
  r1: number;
  w0: number;
  w1: number;
  color: RGB;
  alpha: number;
  /** Peak alpha of a soft filled glow under the ring (0 = none). */
  glow: number;
}

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
  private spotArcs: Arc[] = [];
  private spotRings: SpotRing[] = [];
  private labels: SpotLabel[] = [];
  private labelSeq = 0;
  private marks: { stores: unknown; list: unknown; out: StoreMark[] } = { stores: null, list: null, out: [] };

  constructor(private readonly live: LiveClient) {}

  /** Start listening to batches (and to new oracle cases); returns the unsubscribe. */
  attach() {
    const off = this.live.onBatch((b) => {
      const now = performance.now() / 1000;
      this.add(b, now);
      if (b.spotlight?.length) this.spot(b.spotlight, now);
    });
    const unsub = this.live.subscribe(() => this.watchCases());
    return () => {
      off();
      unsub();
    };
  }

  private casesRef: OracleCase[] | null = null;
  private caseSeen = new Set<string>();

  /**
   * A case the oracle just opened against a store gets an amber flare and its title on the map
   * (suspensions come from the server's spotlight). Cases older than a few seconds, e.g. the list
   * a page receives when it connects, are never announced.
   */
  private watchCases() {
    const cases = this.live.state.cases;
    if (cases === this.casesRef) return;
    this.casesRef = cases;
    const now = performance.now() / 1000;
    for (const c of cases) {
      if (this.caseSeen.has(c.id)) continue;
      this.caseSeen.add(c.id);
      if (c.status !== "open" || Date.now() - c.openedAt > 20_000 || !this.active) continue;
      const subject = c.subjects.find((x) => x.kind === "merchant");
      const m = subject && this.merchants()?.find((d) => d.idx === subject.idx);
      if (!m) continue;
      this.ring({ lon: m.lon, lat: m.lat, born: now, life: 2.4, r0: 5, r1: 60, w0: 3, w1: 1, color: AMBER, alpha: 255, glow: 100 });
      this.ring({ lon: m.lon, lat: m.lat, born: now + 0.3, life: 1.9, r0: 3, r1: 34, w0: 2, w1: 1, color: AMBER, alpha: 220, glow: 0 });
      this.label({ lon: m.lon, lat: m.lat, born: now, tone: "amber", text: c.title, figure: null, sub: `Flagged by the oracle · score ${c.score.toFixed(2)}` });
    }
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
    this.spotArcs = [];
    this.spotRings = [];
    this.labels = [];
  }

  /**
   * Stores the oracle flagged or suspended, with their map positions. Rebuilt only when the
   * store states or the store list change (both are replaced, never mutated, by LiveClient).
   */
  storeMarks(): StoreMark[] {
    const list = this.merchants();
    const stores = this.live.state.stores;
    if (!list) return [];
    if (this.marks.stores === stores && this.marks.list === list) return this.marks.out;
    const byIdx = new Map<number, MerchantDot>();
    for (const m of list) byIdx.set(m.idx, m);
    const out: StoreMark[] = [];
    for (const s of Object.values(stores) as StoreState[]) {
      const suspended = s.status === "suspended";
      if (!suspended && !s.flagged) continue;
      const m = byIdx.get(s.idx);
      if (m) out.push({ position: [m.lon, m.lat], suspended, flagged: s.flagged });
    }
    // Suspended on top of flagged.
    out.sort((a, b) => Number(a.suspended) - Number(b.suspended));
    this.marks = { stores, list, out };
    return out;
  }

  /** Spotlight arcs in flight (same array between events, so deck.gl keeps its buffers). */
  spotArcsAt(now: number): Arc[] {
    const n = this.spotArcs.length;
    if (n && this.spotArcs[0]!.times[ARC_SEGMENTS]! + SPOT_TRAIL < now) {
      this.spotArcs = this.spotArcs.filter((a) => a.times[ARC_SEGMENTS]! + SPOT_TRAIL >= now);
    }
    return this.spotArcs;
  }

  /** Spotlight ripples and shockwaves at this instant (a handful). */
  spotRingsAt(now: number): SpotRingView[] {
    const out: SpotRingView[] = [];
    let keep = 0;
    for (const p of this.spotRings) {
      const age = (now - p.born) / p.life;
      if (age >= 1) continue;
      this.spotRings[keep++] = p;
      if (age < 0) continue;
      const e = 1 - (1 - age) ** 3;
      const fade = (1 - age) ** 1.3;
      out.push({
        position: [p.lon, p.lat],
        radius: p.r0 + (p.r1 - p.r0) * e,
        width: p.w0 + (p.w1 - p.w0) * e,
        line: [p.color[0], p.color[1], p.color[2], p.alpha * fade],
        fill: [p.color[0], p.color[1], p.color[2], p.glow * (1 - age) ** 2.2],
      });
    }
    this.spotRings.length = keep;
    return out;
  }

  /** Labels still on screen, oldest first (at most LABEL_MAX). */
  labelsAt(now: number): SpotLabel[] {
    if (this.labels.length && this.labels[0]!.born + this.labels[0]!.life < now) {
      this.labels = this.labels.filter((l) => l.born + l.life >= now);
    }
    return this.labels;
  }

  private spot(events: Spotlight[], now: number) {
    if (!this.active) return;
    const run = this.live.state.run;
    const perPx = 156_543 / 2 ** this.zoom;
    for (const s of events) {
      if (s.kind === "order" && s.to) {
        const d = meters(s.from, s.to);
        const floor = SPOT_ARC_MIN_PX * perPx * Math.cos((s.to[1] * Math.PI) / 180);
        const h = Math.min(SPOT_ARC_MAX_M, Math.max(floor, d * 0.5));
        const path: [number, number, number][] = [];
        const times: number[] = [];
        for (let i = 0; i <= ARC_SEGMENTS; i++) {
          const f = i / ARC_SEGMENTS;
          path.push([s.from[0] + (s.to[0] - s.from[0]) * f, s.from[1] + (s.to[1] - s.from[1]) * f, h * 4 * f * (1 - f)]);
          times.push(now + SPOT_FLIGHT * f);
        }
        this.spotArcs = [...this.spotArcs.slice(-(SPOT_ARC_MAX - 1)), { path, times, ok: s.ok }];
        const lands = now + SPOT_FLIGHT;
        // Where it starts: a small ping at the home.
        this.ring({ lon: s.from[0], lat: s.from[1], born: now, life: 0.9, r0: 2, r1: 12, w0: 1.5, w1: 1, color: s.ok ? PAID : BLOCKED, alpha: 200, glow: 0 });
        if (s.ok) {
          this.ring({ lon: s.to[0], lat: s.to[1], born: lands, life: 1.4, r0: 3, r1: 28, w0: 2.5, w1: 1, color: AID, alpha: 255, glow: 90 });
          this.ring({ lon: s.to[0], lat: s.to[1], born: lands + 0.18, life: 1.0, r0: 2, r1: 14, w0: 1.5, w1: 1, color: PAID, alpha: 230, glow: 0 });
        } else {
          this.ring({ lon: s.to[0], lat: s.to[1], born: lands, life: 2.0, r0: 4, r1: 38, w0: 3, w1: 1, color: BLOCKED, alpha: 255, glow: 110 });
          this.ring({ lon: s.to[0], lat: s.to[1], born: lands + 0.3, life: 1.6, r0: 3, r1: 22, w0: 2, w1: 1, color: BLOCKED, alpha: 220, glow: 0 });
        }
        this.label({
          lon: s.to[0],
          lat: s.to[1],
          born: now,
          tone: s.ok ? "teal" : "red",
          text: s.label,
          figure: s.usd > 0 ? money(s.usd) : null,
          sub: s.ok ? null : `Blocked by the chain · ${s.rule ? ruleLabel(s.rule, run?.rules) : "rejected"}`,
        });
      } else if (s.kind === "join") {
        const [lon, lat] = s.from;
        for (let i = 0; i < 3; i++) {
          this.ring({ lon, lat, born: now + i * 0.32, life: 2.3, r0: 5, r1: 58 - i * 10, w0: 3 - i * 0.6, w1: 1, color: AID, alpha: 255 - i * 40, glow: i === 0 ? 120 : 0 });
        }
        this.label({ lon, lat, born: now, tone: "teal", text: s.label, figure: s.usd > 0 ? `+${s.usd % 1 === 0 ? usd(s.usd) : money(s.usd)}` : null, sub: null });
      } else if (s.kind === "oracle") {
        const [lon, lat] = s.from;
        const restore = /reinstated|thawed|unfrozen/i.test(s.label);
        const main = restore ? AID : BLOCKED;
        this.ring({ lon, lat, born: now, life: 2.6, r0: 6, r1: 76, w0: 3.5, w1: 1, color: main, alpha: 255, glow: 110 });
        this.ring({ lon, lat, born: now + 0.22, life: 2.2, r0: 4, r1: 48, w0: 2.5, w1: 1, color: restore ? PAID : AMBER, alpha: 230, glow: 0 });
        this.ring({ lon, lat, born: now + 0.5, life: 1.8, r0: 3, r1: 26, w0: 2, w1: 1, color: main, alpha: 200, glow: 0 });
        this.label({ lon, lat, born: now, tone: restore ? "teal" : "red", text: s.label, figure: null, sub: "Oracle key · on-chain" });
      }
    }
  }

  private label(l: Omit<SpotLabel, "id" | "life">) {
    const now = l.born;
    this.labels = this.labels.filter((x) => x.born + x.life >= now);
    if (this.labels.length >= LABEL_MAX) this.labels = this.labels.slice(this.labels.length - LABEL_MAX + 1);
    this.labels = [...this.labels, { ...l, id: ++this.labelSeq, life: LABEL_LIFE }];
  }

  private ring(r: SpotRing) {
    if (this.spotRings.length >= SPOT_RING_MAX) this.spotRings.splice(0, this.spotRings.length - SPOT_RING_MAX + 1);
    this.spotRings.push(r);
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
