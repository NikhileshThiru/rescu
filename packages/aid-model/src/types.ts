/** Per-quadrant radius in nautical miles, ordered NE, SE, SW, NW. null = not reported. */
export type Quadrants = [number | null, number | null, number | null, number | null];

/** One HURDAT2 best-track fix (every 6 h, plus special fixes such as landfall). */
export interface StormPoint {
  /** Unix seconds (UTC). */
  t: number;
  lat: number;
  lon: number;
  /** Max sustained wind, knots. */
  vmax: number | null;
  pmin: number | null;
  /** HU, TS, TD, EX, LO, ... */
  status: string;
  /** "L" = landfall. */
  record: string;
  r34: Quadrants;
  r50: Quadrants;
  r64: Quadrants;
  /** Radius of maximum wind, nm (reported since 2021). */
  rmw: number | null;
}

export interface Storm {
  id: string;
  slug: string;
  name: string;
  year: number;
  points: StormPoint[];
  landfalls: { t: number; lat: number; lon: number; vmax: number | null }[];
}

/** Four resolved radii (NE, SE, SW, NW), or null when the fix didn't report them. */
export type Radii = [number, number, number, number] | null;

/** The storm at one instant, interpolated from the best track. */
export interface StormState {
  t: number;
  lat: number;
  lon: number;
  vmax: number;
  rmw: number;
  r34: Radii;
  r50: Radii;
  r64: Radii;
}

/** 0 below tropical-storm force, then 34-49, 50-63, 64-95, 96+ kt. */
export type Band = 0 | 1 | 2 | 3 | 4;
export const BAND_LABELS = ["Below 34 kt", "Tropical storm", "Strong tropical storm", "Hurricane", "Major hurricane"] as const;

export function bandOf(kt: number): Band {
  if (kt >= 96) return 4;
  if (kt >= 64) return 3;
  if (kt >= 50) return 2;
  if (kt >= 34) return 1;
  return 0;
}

/** Peak conditions a location saw over the whole storm. */
export interface Impact {
  maxKt: number;
  band: Band;
  /** When the peak wind arrived (unix s), or null if never above 0. */
  peakT: number | null;
  /** First time tropical-storm (34 kt), 50 kt and hurricane (64 kt) winds arrived. */
  t34: number | null;
  t50: number | null;
  t64: number | null;
}
