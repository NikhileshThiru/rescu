import type { Layer } from "@deck.gl/core";
import { TripsLayer } from "@deck.gl/geo-layers";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { MerchantDot } from "@rescu/live";
import { ARC_TRAIL, type Arc, type LiveEffects, type PulseView } from "./live-effects";
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
