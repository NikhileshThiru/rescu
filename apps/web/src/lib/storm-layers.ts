import type { Layer } from "@deck.gl/core";
import { PathStyleExtension } from "@deck.gl/extensions";
import { PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { isotachRing, type Storm, type StormState, stormState } from "@rescu/aid-model";
import { StormCloudLayer } from "./storm-cloud-layer";

const ON_TOP = { depthCompare: "always", depthWriteEnabled: false } as const;
const dash = new PathStyleExtension({ dash: true });
const MAX_CLOUD_NM = 320;

const RINGS = [
  { kt: 34 as const, fill: [90, 148, 232, 18], line: [90, 148, 232, 120] },
  { kt: 50 as const, fill: [142, 192, 255, 22], line: [142, 192, 255, 160] },
  { kt: 64 as const, fill: [238, 246, 255, 28], line: [238, 246, 255, 220] },
];

export interface StormFrame {
  state: StormState | null;
  past: [number, number][];
  future: [number, number][];
}

/** Where the storm is at t, plus the track split into travelled and still-to-come. */
export function stormFrame(storm: Storm, t: number): StormFrame {
  const state = stormState(storm, t);
  const past: [number, number][] = [];
  const future: [number, number][] = [];
  for (const p of storm.points) (p.t <= t ? past : future).push([p.lon, p.lat]);
  if (state) {
    past.push([state.lon, state.lat]);
    future.unshift([state.lon, state.lat]);
  }
  return { state, past, future };
}

/** Square around the eye, `radiusNm` to each side, as [bottom-left, top-left, top-right, bottom-right]. */
function cloudBounds(s: StormState, radiusNm: number): [number, number][] {
  const dLat = radiusNm / 60;
  const dLon = dLat / Math.cos((s.lat * Math.PI) / 180);
  return [
    [s.lon - dLon, s.lat - dLat],
    [s.lon - dLon, s.lat + dLat],
    [s.lon + dLon, s.lat + dLat],
    [s.lon + dLon, s.lat - dLat],
  ];
}

export function stormLayers({
  storm,
  frame,
  realTimeSec,
  reduceMotion,
  beforeId,
  landfallsSeen,
  cloudFade = 0,
}: {
  storm: Storm;
  frame: StormFrame;
  realTimeSec: number;
  reduceMotion: boolean;
  beforeId?: string;
  landfallsSeen: { lon: number; lat: number; age: number }[];
  /** 0..1, thins the cloud so the aid layer reads through it. */
  cloudFade?: number;
}): Layer[] {
  const layers: Layer[] = [];
  const { state } = frame;

  layers.push(
    new PathLayer({
      id: "track-future",
      data: [frame.future],
      getPath: (d) => d,
      getColor: [220, 232, 255, 70],
      getWidth: 1.5,
      widthUnits: "pixels",
      getDashArray: [3, 4],
      dashJustified: true,
      extensions: [dash],
      parameters: ON_TOP,
      beforeId,
    }),
    new PathLayer({
      id: "track-past",
      data: [frame.past],
      getPath: (d) => d,
      getColor: [220, 232, 255, 200],
      getWidth: 2,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      parameters: ON_TOP,
      beforeId,
    }),
    new ScatterplotLayer({
      id: "landfalls",
      data: landfallsSeen,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 5 + 3 * Math.max(0, 1 - d.age),
      radiusUnits: "pixels",
      stroked: true,
      filled: true,
      getFillColor: [7, 11, 20, 255],
      getLineColor: [220, 232, 255, 230],
      lineWidthUnits: "pixels",
      getLineWidth: 1.5,
      parameters: ON_TOP,
      updateTriggers: { getRadius: landfallsSeen.map((l) => l.age.toFixed(2)).join() },
      beforeId,
    }),
  );

  if (!state) return layers;

  const rings = RINGS.map((r) => ({ ...r, polygon: isotachRing(state, r.kt) })).filter((r) => r.polygon);
  layers.push(
    new PolygonLayer({
      id: "isotachs",
      data: rings,
      getPolygon: (d) => d.polygon!,
      getFillColor: (d) => d.fill as [number, number, number, number],
      getLineColor: (d) => d.line as [number, number, number, number],
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      stroked: true,
      filled: true,
      parameters: ON_TOP,
    }),
  );

  // Mean 34 kt radius, capped: storms going extratropical report enormous, lopsided radii.
  const outer = state.r34 ? state.r34.reduce((a, b) => a + b, 0) / 4 : 0;
  const radius = Math.min(MAX_CLOUD_NM, Math.max(outer * 1.35, state.rmw * 4, 55));
  const strength = Math.min(1, Math.max(0, (state.vmax - 30) / 85));
  layers.push(
    new StormCloudLayer({
      id: "storm-cloud",
      image: null,
      bounds: cloudBounds(state, radius) as never,
      cloud: {
        time: reduceMotion ? 0 : realTimeSec,
        spin: reduceMotion ? 0 : realTimeSec * 0.16 + state.t / 50_000,
        strength,
        eye: Math.min(0.1, Math.max(0.04, (state.rmw * 0.7) / radius)),
        core: Math.min(0.42, Math.max(0.16, (state.rmw * 2.6) / radius, 0.16 + 0.14 * strength)),
        seed: (storm.year % 7) * 1.37,
        opacity: (0.45 + 0.45 * strength) * (1 - 0.65 * cloudFade),
      },
      parameters: ON_TOP,
    }),
  );

  const pulse = reduceMotion ? 0.5 : (realTimeSec % 2.2) / 2.2;
  layers.push(
    new ScatterplotLayer({
      id: "eye",
      data: [
        { r: 10 + 34 * pulse, fill: [0, 0, 0, 0], line: [220, 232, 255, Math.round(200 * (1 - pulse))] },
        { r: 2.5, fill: [235, 242, 255, 230], line: [0, 0, 0, 0] },
      ],
      getPosition: () => [state.lon, state.lat],
      getRadius: (d) => d.r,
      radiusUnits: "pixels",
      stroked: true,
      getFillColor: (d) => d.fill as [number, number, number, number],
      getLineColor: (d) => d.line as [number, number, number, number],
      lineWidthUnits: "pixels",
      getLineWidth: 1.5,
      parameters: ON_TOP,
      updateTriggers: { getRadius: pulse, getLineColor: pulse, getPosition: state.t },
    }),
  );
  return layers;
}
