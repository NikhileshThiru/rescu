import type { Layer } from "@deck.gl/core";
import { TripsLayer } from "@deck.gl/geo-layers";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { MerchantDot } from "@rescu/live";
import { ARC_TRAIL, type Arc, type LiveEffects, type PulseView, SPOT_TRAIL, type SpotLabel, type SpotRingView, type StoreMark } from "./live-effects";
import { hex, type RGB } from "./tokens";

const ON_TOP = { depthCompare: "always", depthWriteEnabled: false } as const;

/** Same colours as the rail's "Where the aid is spent" bar. */
const CATEGORY: Record<string, RGB> = {
  grocery: hex("#2dd4bf"),
  pharmacy: hex("#a78bfa"),
  hardware: hex("#f5b83d"),
  general: hex("#86a8e2"),
};
const CLOSED_LINE: [number, number, number, number] = [150, 162, 184, 210];
const BG_FILL: [number, number, number, number] = [7, 11, 20, 210];
const ARC_OK: [number, number, number] = [164, 242, 228];
const ARC_BLOCKED: [number, number, number] = [240, 97, 109];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function closedAt(m: MerchantDot, t: number) {
  return m.closedFrom !== null && t >= m.closedFrom && (m.reopensAt === null || t < m.reopensAt);
}

/**
 * The run's registered stores: a dot per store in its category colour, a hollow ring while the
 * storm has it closed. Small at region zoom, growing as the presenter zooms in.
 */
export function merchantLayer(merchants: MerchantDot[], t: number, zoom: number, beforeId?: string): Layer {
  let closed = 0;
  let sum = 0;
  for (const m of merchants) {
    if (closedAt(m, t)) {
      closed++;
      sum += m.idx;
    }
  }
  const key = `${merchants.length}:${closed}:${sum}`;
  return new ScatterplotLayer<MerchantDot>({
    id: "merchants",
    data: merchants,
    getPosition: (d) => [d.lon, d.lat],
    getRadius: 2.2,
    radiusUnits: "pixels",
    radiusScale: clamp(0.75 + (zoom - 5) * 0.4, 0.75, 2.4),
    stroked: true,
    filled: true,
    getFillColor: (d) => (closedAt(d, t) ? BG_FILL : [...(CATEGORY[d.category] ?? CATEGORY.general!), 235]),
    getLineColor: (d) => (closedAt(d, t) ? CLOSED_LINE : BG_FILL),
    lineWidthUnits: "pixels",
    getLineWidth: (d) => (closedAt(d, t) ? 1.2 : 0.9),
    opacity: clamp((zoom - 4.6) / 2.4, 0.35, 1),
    updateTriggers: { getFillColor: key, getLineColor: key, getLineWidth: key },
    parameters: ON_TOP,
    ...({ beforeId } as object),
  });
}

/** Purchases flying home -> store (GPU-animated), and the rings for aid landing, purchases and blocks. */
export function effectLayers(fx: LiveEffects, nowSec: number, beforeId?: string): Layer[] {
  return [
    new TripsLayer<Arc>({
      id: "pay-arcs",
      data: fx.arcsAt(nowSec),
      getPath: (d) => d.path,
      getTimestamps: (d) => d.times,
      getColor: (d) => (d.ok ? ARC_OK : ARC_BLOCKED),
      getWidth: 2,
      widthUnits: "pixels",
      widthMinPixels: 1.5,
      capRounded: true,
      jointRounded: true,
      currentTime: nowSec,
      trailLength: ARC_TRAIL,
      fadeTrail: true,
      parameters: ON_TOP,
      ...({ beforeId } as object),
    }),
    new ScatterplotLayer<PulseView>({
      id: "pulses",
      data: fx.pulsesAt(nowSec),
      getPosition: (d) => d.position,
      getRadius: (d) => d.radius,
      radiusUnits: "pixels",
      stroked: true,
      filled: false,
      getLineColor: (d) => d.color,
      getLineWidth: (d) => d.width,
      lineWidthUnits: "pixels",
      parameters: ON_TOP,
      ...({ beforeId } as object),
    }),
  ];
}

const AMBER: RGB = hex("#f5b83d");
const RED: RGB = hex("#f0616d");
const SPOT_GLOW_OK: [number, number, number, number] = [45, 212, 191, 120];
const SPOT_CORE_OK: [number, number, number] = [226, 255, 250];
const SPOT_GLOW_BAD: [number, number, number, number] = [240, 97, 109, 130];
const SPOT_CORE_BAD: [number, number, number] = [255, 214, 218];

/**
 * Stores the oracle is watching: flagged = an amber halo that breathes, suspended = a red dot
 * inside a red ring. Bigger than the plain store dots, and fully opaque at region zoom, so a
 * gouger reads from across the map. At most a few dozen, so the per-frame breathing is free.
 */
export function storeStatusLayers(marks: StoreMark[], zoom: number, nowSec: number, reduceMotion: boolean, beforeId?: string): Layer[] {
  if (!marks.length) return [];
  const scale = clamp(0.95 + (zoom - 5) * 0.22, 0.95, 1.7);
  const breath = reduceMotion ? 1 : 1 + 0.16 * Math.sin(nowSec * 2.6);
  const phase = reduceMotion ? 0 : Math.round(breath * 40);
  const tone = (m: StoreMark) => (m.suspended ? RED : AMBER);
  return [
    new ScatterplotLayer<StoreMark>({
      id: "store-halo",
      data: marks,
      getPosition: (d) => d.position,
      getRadius: (d) => (d.suspended ? 11 : 12 * breath),
      radiusUnits: "pixels",
      radiusScale: scale,
      filled: true,
      stroked: false,
      getFillColor: (d) => [...tone(d), d.suspended ? 46 : 40],
      updateTriggers: { getRadius: phase },
      parameters: ON_TOP,
      ...({ beforeId } as object),
    }),
    new ScatterplotLayer<StoreMark>({
      id: "store-ring",
      data: marks,
      getPosition: (d) => d.position,
      getRadius: (d) => (d.suspended ? 7 : 7 * breath),
      radiusUnits: "pixels",
      radiusScale: scale,
      filled: false,
      stroked: true,
      getLineColor: (d) => [...tone(d), 255],
      getLineWidth: (d) => (d.suspended ? 1.8 : 1.5),
      lineWidthUnits: "pixels",
      updateTriggers: { getRadius: phase },
      parameters: ON_TOP,
      ...({ beforeId } as object),
    }),
    new ScatterplotLayer<StoreMark>({
      id: "store-core",
      data: marks,
      getPosition: (d) => d.position,
      getRadius: (d) => (d.suspended ? 3.6 : 2.8),
      radiusUnits: "pixels",
      radiusScale: scale,
      filled: true,
      stroked: true,
      getFillColor: (d) => [...tone(d), 255],
      getLineColor: BG_FILL,
      getLineWidth: 1,
      lineWidthUnits: "pixels",
      parameters: ON_TOP,
      ...({ beforeId } as object),
    }),
  ];
}

/**
 * What a person, an agent or the oracle just did: a taller, slower arc with a soft glow and a
 * bright core (red when the chain refused it), and ripples / shockwaves that outlive the crowd's.
 */
export function spotLayers(fx: LiveEffects, nowSec: number, beforeId?: string): Layer[] {
  // Always present (empty most of the time) so a spotlight never pays for layer setup mid-demo.
  const arcs = fx.spotArcsAt(nowSec);
  const rings = fx.spotRingsAt(nowSec);
  return [
    new TripsLayer<Arc>({
      id: "spot-arcs-glow",
      data: arcs,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.times,
      getColor: (d) => (d.ok ? SPOT_GLOW_OK : SPOT_GLOW_BAD),
      getWidth: 9,
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      currentTime: nowSec,
      trailLength: SPOT_TRAIL,
      fadeTrail: true,
      parameters: ON_TOP,
      ...({ beforeId } as object),
    }),
    new TripsLayer<Arc>({
      id: "spot-arcs",
      data: arcs,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.times,
      getColor: (d) => (d.ok ? SPOT_CORE_OK : SPOT_CORE_BAD),
      getWidth: 2.6,
      widthUnits: "pixels",
      capRounded: true,
      jointRounded: true,
      currentTime: nowSec,
      trailLength: SPOT_TRAIL,
      fadeTrail: true,
      parameters: ON_TOP,
      ...({ beforeId } as object),
    }),
    new ScatterplotLayer<SpotRingView>({
      id: "spot-rings",
      data: rings,
      getPosition: (d) => d.position,
      getRadius: (d) => d.radius,
      radiusUnits: "pixels",
      stroked: true,
      filled: true,
      getFillColor: (d) => d.fill,
      getLineColor: (d) => d.line,
      getLineWidth: (d) => d.width,
      lineWidthUnits: "pixels",
      parameters: ON_TOP,
      ...({ beforeId } as object),
    }),
  ];
}

/** Reduced motion: a still marker under each spotlight label instead of arcs and ripples. */
export function spotMarkerLayer(labels: SpotLabel[], beforeId?: string): Layer | null {
  if (!labels.length) return null;
  const tone = (l: SpotLabel) => (l.tone === "red" ? RED : l.tone === "amber" ? AMBER : hex("#2dd4bf"));
  return new ScatterplotLayer<SpotLabel>({
    id: "spot-markers",
    data: labels,
    getPosition: (d) => [d.lon, d.lat],
    getRadius: 5,
    radiusUnits: "pixels",
    filled: true,
    stroked: true,
    getFillColor: (d) => [...tone(d), 255],
    getLineColor: [230, 237, 247, 220],
    getLineWidth: 1.5,
    lineWidthUnits: "pixels",
    parameters: ON_TOP,
    ...({ beforeId } as object),
  });
}
