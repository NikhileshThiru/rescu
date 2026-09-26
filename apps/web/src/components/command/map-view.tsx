"use client";

import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { type GeoJSONSource, type IControl, Map as MLMap } from "maplibre-gl";
import { useReducedMotion } from "motion/react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import {
  CAMERA_PADDING,
  CHASE_LAG_SEC,
  chaseCamera,
  overviewCamera,
  SHOT_EASE_MS,
  type Shot,
  shotAt,
} from "@/lib/camera";
import type { SimClock } from "@/lib/clock";
import { category, mph } from "@/lib/format";
import { HexField } from "@/lib/hex-field";
import type { LiveEffects } from "@/lib/live-effects";
import { effectLayers, merchantLayer } from "@/lib/live-layers";
import { firstLabelLayer, loadMapStyle } from "@/lib/map-style";
import type { StormFile } from "@/lib/storm-data";
import { stormFrame, stormLayers } from "@/lib/storm-layers";

export type LayerMode = "wind" | "aid";

export interface HexHover {
  index: number;
  x: number;
  y: number;
  field: HexField;
}

export interface MapViewHandle {
  /** Fly to the storm at the current sim time and hand the camera to the director. */
  introduce: (file: StormFile, opts?: { duration?: number }) => void;
  /** Give the camera back to the director after the presenter moved it. */
  follow: () => void;
}

const US_VIEW = { center: [-93.5, 37.2] as [number, number], zoom: 3.4, pitch: 0, bearing: 0 };
const MASK_RINGS = 5;
const MIX_MS = 900;

const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

const HEX_MATERIAL = { ambient: 0.42, diffuse: 0.62, shininess: 24, specularColor: [48, 56, 72] as [number, number, number] };
const HEX_HIGHLIGHT: [number, number, number, number] = [255, 255, 255, 46];

function maskGeoJSON(ring: [number, number][] | null) {
  const world: [number, number][] = [
    [-180, -85],
    [180, -85],
    [180, 85],
    [-180, 85],
    [-180, -85],
  ];
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: ring ? [world, [...ring].reverse()] : [world] },
  };
}

export const MapView = forwardRef<
  MapViewHandle,
  {
    file: StormFile | null;
    res: number;
    mode: LayerMode;
    clock: SimClock;
    /** The live network's stores, purchase arcs and aid flashes. */
    effects?: LiveEffects | null;
    onHover: (h: HexHover | null) => void;
    onReady?: () => void;
    /** Director on (true) or the presenter has taken the camera (false). */
    onCameraAuto?: (auto: boolean) => void;
  }
>(function MapView({ file, res, mode, clock, effects = null, onHover, onReady, onCameraAuto }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const labelEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const beforeId = useRef<string | undefined>(undefined);
  const reduceMotion = useReducedMotion() ?? false;

  // Everything the frame loop reads lives in refs so props never restart the loop.
  const live = useRef({
    file,
    field: null as HexField | null,
    mode,
    mix: mode === "aid" ? 1 : 0,
    mixFrom: 0,
    mixStart: 0,
    lastClockFrame: -1,
    dirty: true,
    reduceMotion,
    onHover,
    onCameraAuto,
    styleReady: false,
    /** Director camera: current shot, and until when a scripted move owns the camera. */
    camera: { auto: false, shot: null as Shot | null, busyUntil: 0 },
    effects,
  });
  live.current.effects = effects;
  live.current.onHover = onHover;
  live.current.onCameraAuto = onCameraAuto;
  live.current.reduceMotion = reduceMotion;

  useImperativeHandle(ref, () => ({
    introduce(f, opts) {
      const map = mapRef.current;
      if (!map) return;
      const cam = live.current.camera;
      const shot = shotAt(f.storm, clock.t, live.current.reduceMotion);
      const target = shot === "chase" ? chaseCamera(f.storm, clock.t, map.getContainer().clientWidth) : overviewCamera(map, f);
      const duration = live.current.reduceMotion ? 0 : (opts?.duration ?? 4200);
      if (duration === 0) map.jumpTo({ ...target, padding: CAMERA_PADDING });
      else map.flyTo({ ...target, padding: CAMERA_PADDING, duration, curve: 1.45, essential: true, easing: easeInOut });
      cam.auto = true;
      cam.shot = shot;
      cam.busyUntil = performance.now() + duration;
      live.current.onCameraAuto?.(true);
    },
    follow() {
      const cam = live.current.camera;
      cam.auto = true;
      cam.shot = null; // the loop eases to whichever shot fits the current time
      cam.busyUntil = 0;
      live.current.onCameraAuto?.(true);
    },
  }));

  // Map + overlay, once.
  useEffect(() => {
    let cancelled = false;
    let map: MLMap | null = null;
    loadMapStyle().then((style) => {
      if (cancelled || !container.current) return;
      beforeId.current = firstLabelLayer(style);
      const m = new MLMap({
        container: container.current,
        style,
        ...US_VIEW,
        attributionControl: { compact: true },
        maxPitch: 70,
        canvasContextAttributes: { antialias: true },
      });
      map = m;
      mapRef.current = m;
      if (process.env.NODE_ENV !== "production") (window as unknown as { __rescuMap: MLMap }).__rescuMap = m;
      // A drag, scroll-zoom, rotate or pitch by the presenter hands them the camera.
      const takeOver = (e: { originalEvent?: unknown }) => {
        const cam = live.current.camera;
        if (!e.originalEvent || !cam.auto) return;
        cam.auto = false;
        live.current.onCameraAuto?.(false);
      };
      for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"] as const) m.on(ev, takeOver);
      m.on("load", () => {
        const map = m;
        for (let i = 0; i < MASK_RINGS; i++) {
          map.addSource(`focus-mask-${i}`, { type: "geojson", data: maskGeoJSON(null) });
          map.addLayer(
            {
              id: `focus-mask-${i}`,
              type: "fill",
              source: `focus-mask-${i}`,
              paint: { "fill-color": "#04060c", "fill-opacity": 0, "fill-opacity-transition": { duration: 1200, delay: 0 } },
            },
            beforeId.current,
          );
        }
        const overlay = new MapboxOverlay({
          interleaved: true,
          layers: [],
          onHover: (info) => {
            const f = live.current.field;
            if (!f || info.layer?.id !== "hexes" || info.index < 0 || !f.visible(info.index)) {
              live.current.onHover(null);
              return;
            }
            live.current.onHover({ index: info.index, x: info.x, y: info.y, field: f });
          },
        });
        map.addControl(overlay as unknown as IControl);
        overlayRef.current = overlay;
        live.current.styleReady = true;
        live.current.dirty = true;
        onReady?.();
      });
    });
    return () => {
      cancelled = true;
      overlayRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New storm or resolution: rebuild the hex field and the focus mask.
  useEffect(() => {
    live.current.file = file;
    live.current.field = file ? new HexField(file, res) : null;
    live.current.dirty = true;
  }, [file, res]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !file) return;
    const apply = () => {
      for (let i = 0; i < MASK_RINGS; i++) {
        // Each ring dims everything outside it, so the stack darkens gradually past the edge.
        (map.getSource(`focus-mask-${i}`) as GeoJSONSource | undefined)?.setData(maskGeoJSON(file.focus.rings[i] ?? null));
        map.setPaintProperty(`focus-mask-${i}`, "fill-opacity", 0.07);
      }
    };
    if (live.current.styleReady) apply();
    else map.once("load", apply);
  }, [file]);

  useEffect(() => {
    const l = live.current;
    if (l.mode === mode) return;
    l.mixFrom = l.mix;
    l.mixStart = performance.now();
    l.mode = mode;
  }, [mode]);

  // The one frame loop.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let labelKey = "";
    const landfallAge = new Map<number, number>();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      clock.tick(dt);
      const l = live.current;
      const overlay = overlayRef.current;
      const map = mapRef.current;
      if (!overlay || !map || !l.file) return;

      const target = l.mode === "aid" ? 1 : 0;
      let mixChanged = false;
      if (l.mix !== target) {
        const p = l.reduceMotion ? 1 : Math.min(1, (now - l.mixStart) / MIX_MS);
        l.mix = l.mixFrom + (target - l.mixFrom) * easeInOut(p);
        if (p >= 1) l.mix = target;
        mixChanged = true;
      }

      const field = l.field;
      const clockMoved = clock.frame !== l.lastClockFrame;
      if (field && (clockMoved || mixChanged || l.dirty)) {
        field.update(clock.t, l.mix);
      }
      const hexVersion = `${clock.frame}:${l.mix.toFixed(4)}:${field?.res}:${field?.n}`;
      l.lastClockFrame = clock.frame;
      l.dirty = false;

      const storm = l.file.storm;
      const frame = stormFrame(storm, clock.t);

      // Director camera: ease between shots, and trail the eye smoothly while chasing.
      const cam = l.camera;
      if (cam.auto && now >= cam.busyUntil) {
        const shot = shotAt(storm, clock.t, l.reduceMotion);
        if (shot !== cam.shot) {
          const target = shot === "chase" ? chaseCamera(storm, clock.t, map.getContainer().clientWidth) : overviewCamera(map, l.file);
          const duration = l.reduceMotion ? 0 : SHOT_EASE_MS;
          map.easeTo({ ...target, padding: CAMERA_PADDING, duration, easing: easeInOut, essential: true });
          cam.shot = shot;
          cam.busyUntil = now + duration;
        } else if (shot === "chase" && frame.state) {
          const c = map.getCenter();
          const k = 1 - Math.exp(-dt / CHASE_LAG_SEC);
          const dLon = frame.state.lon - c.lng;
          const dLat = frame.state.lat - c.lat;
          if (Math.abs(dLon) + Math.abs(dLat) > 1e-4) map.jumpTo({ center: [c.lng + dLon * k, c.lat + dLat * k] });
        }
      }
      const landfallsSeen = storm.landfalls
        .filter((lf) => lf.t <= clock.t)
        .map((lf) => {
          if (!landfallAge.has(lf.t)) landfallAge.set(lf.t, now);
          return { lon: lf.lon, lat: lf.lat, age: (now - landfallAge.get(lf.t)!) / 700 };
        });
      for (const t of landfallAge.keys()) if (t > clock.t) landfallAge.delete(t);

      const layers = [];
      if (field) {
        layers.push(
          new H3HexagonLayer<string>({
            id: "hexes",
            data: field.h3,
            getHexagon: (d) => d,
            extruded: true,
            coverage: 0.86,
            getFillColor: (_, { index, target: out }) => {
              const o = index * 4;
              const c = field.color;
              const t = out as unknown as number[];
              t[0] = c[o]!;
              t[1] = c[o + 1]!;
              t[2] = c[o + 2]!;
              t[3] = c[o + 3]!;
              return t as [number, number, number, number];
            },
            getElevation: (_, { index }) => field.height[index]!,
            elevationScale: 1,
            material: HEX_MATERIAL,
            pickable: true,
            autoHighlight: true,
            highlightColor: HEX_HIGHLIGHT,
            updateTriggers: { getFillColor: hexVersion, getElevation: hexVersion },
            ...({ beforeId: beforeId.current } as object),
          }),
        );
      }
      const fx = l.effects?.active ? l.effects : null;
      const zoom = map.getZoom();
      if (fx) fx.zoom = zoom;
      const stores = fx?.merchants();
      if (stores) layers.push(merchantLayer(stores, clock.t, zoom, beforeId.current));
      layers.push(
        ...stormLayers({
          storm,
          frame,
          realTimeSec: now / 1000,
          reduceMotion: l.reduceMotion,
          beforeId: beforeId.current,
          landfallsSeen,
          cloudFade: l.mix,
        }),
      );
      if (fx && !l.reduceMotion) layers.push(...effectLayers(fx, now / 1000, beforeId.current));
      overlay.setProps({ layers });

      const el = labelEl.current;
      if (el) {
        const s = frame.state;
        if (s) {
          const p = map.project([s.lon, s.lat]);
          el.style.transform = `translate(${p.x + 30}px, ${p.y - 14}px)`;
          el.style.opacity = "1";
          const cat = category(s.vmax);
          const key = `${cat.short}|${mph(s.vmax)}`;
          if (key !== labelKey) {
            labelKey = key;
            el.querySelector("[data-cat]")!.textContent = cat.short;
            el.querySelector("[data-wind]")!.textContent = `${mph(s.vmax)} mph`;
          }
        } else el.style.opacity = "0";
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" />
      <div
        ref={labelEl}
        className="pointer-events-none absolute left-0 top-0 flex items-center gap-2 whitespace-nowrap opacity-0 transition-opacity duration-500"
        style={{ willChange: "transform" }}
      >
        <span className="rounded bg-bg/60 px-1.5 py-px text-xs font-semibold uppercase tracking-[0.16em] text-storm">{file?.storm.name}</span>
        <span data-cat className="rounded-full border border-storm/20 bg-bg/70 px-1.5 py-px text-2xs font-medium text-storm tabular" />
        <span data-wind className="text-2xs text-text-2 tabular" />
      </div>
    </div>
  );
});
