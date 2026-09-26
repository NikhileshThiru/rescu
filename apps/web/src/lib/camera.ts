import { type Storm, stormState } from "@rescu/aid-model";
import type { LngLatLike, Map as MLMap, PaddingOptions } from "maplibre-gl";
import type { StormFile } from "./storm-data";

/**
 * The Command Center's director camera: follow the storm up close and tilted through landfall,
 * then pull back to the whole area aid went to. Any drag or zoom by the presenter hands the
 * camera over until they press "Follow storm".
 */

/** Room for the panels: controls on the left, the rail on the right, the timeline below. */
export const CAMERA_PADDING = { top: 80, bottom: 190, left: 300, right: 400 } satisfies PaddingOptions;
export const CHASE_PITCH = 52;
export const OVERVIEW_PITCH = 40;
export const CAMERA_BEARING = -10;
/** Sim time after the main landfall when the camera pulls back to the whole aid area. */
export const OVERVIEW_AFTER = 10 * 3600;
/** How quickly the chase camera catches up with the eye (seconds of real time). */
export const CHASE_LAG_SEC = 0.9;
export const SHOT_EASE_MS = 2600;

export type Shot = "chase" | "overview";

export function mainLandfall(storm: Storm): number {
  const lfs = storm.landfalls;
  if (!lfs.length) return storm.points[0]!.t;
  return lfs.reduce((a, b) => ((b.vmax ?? 0) > (a.vmax ?? 0) ? b : a)).t;
}

/** Chase until a while after the main landfall (or once the storm is gone), then overview. */
export function shotAt(storm: Storm, t: number, reduceMotion: boolean): Shot {
  if (reduceMotion) return "overview";
  return t < mainLandfall(storm) + OVERVIEW_AFTER && stormState(storm, t) ? "chase" : "overview";
}

/**
 * Zoom that makes the storm's tropical-storm wind field (mean 34 kt radius at landfall) span
 * about 60% of the open map width. MapLibre's world is 512 px wide at zoom 0.
 */
export function chaseZoom(storm: Storm, mapWidthPx: number): number {
  const s = stormState(storm, mainLandfall(storm)) ?? stormState(storm, storm.points[0]!.t)!;
  const r34 = s.r34 ? s.r34.reduce((a, b) => a + b, 0) / 4 : 150;
  const radiusNm = Math.min(300, Math.max(80, r34));
  const usable = Math.max(320, mapWidthPx - (CAMERA_PADDING.left + CAMERA_PADDING.right));
  const metersPerPx = (2 * radiusNm * 1852) / (0.6 * usable);
  const zoom = Math.log2((78_271.52 * Math.cos((s.lat * Math.PI) / 180)) / metersPerPx);
  return Math.min(6.6, Math.max(4.6, zoom));
}

export function chaseCamera(storm: Storm, t: number, mapWidthPx: number) {
  const s = stormState(storm, t) ?? stormState(storm, storm.points[0]!.t)!;
  return {
    center: [s.lon, s.lat] as [number, number],
    zoom: chaseZoom(storm, mapWidthPx),
    pitch: CHASE_PITCH,
    bearing: CAMERA_BEARING,
  };
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unmercY = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

/**
 * The whole aid area, fitted in Web Mercator by hand. (map.cameraForBounds adds the map's current
 * padding on top of the padding it's given, so after the first padded move it fits the bounds
 * into a sliver and zooms far out.) Backs off a little because the view is tilted.
 */
export function overviewCamera(map: MLMap, file: StormFile) {
  const [[w, s], [e, n]] = file.focus.bounds;
  const el = map.getContainer();
  const width = Math.max(320, el.clientWidth - CAMERA_PADDING.left - CAMERA_PADDING.right);
  const height = Math.max(240, el.clientHeight - CAMERA_PADDING.top - CAMERA_PADDING.bottom);
  const zx = Math.log2((width * 360) / (512 * Math.max(0.5, e - w)));
  const zy = Math.log2((height * 2 * Math.PI) / (512 * Math.max(0.01, mercY(n) - mercY(s))));
  return {
    center: [(w + e) / 2, unmercY((mercY(n) + mercY(s)) / 2)] as LngLatLike,
    zoom: Math.min(zx, zy) - 0.15,
    pitch: OVERVIEW_PITCH,
    bearing: CAMERA_BEARING,
  };
}
