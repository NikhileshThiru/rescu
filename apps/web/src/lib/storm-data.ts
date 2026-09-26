import type { Storm } from "@rescu/aid-model";
import { timelineDomain } from "@rescu/live";

/** Written by data/pipeline/export-web.ts. Columnar so a 15k-hex file stays ~1 MB. */
export interface HexColumns {
  h3: string[];
  kt: number[];
  /** Minutes after the first best-track fix; -1 = never reached. */
  t34: number[];
  t50: number[];
  t64: number[];
  peak: number[];
  households: number[];
  eligible: number[];
  /** Dollars. */
  aid: number[];
  needPct: number[];
  rainIn: number[];
  surge: number[];
  svi: number[];
  /** Index into `hazards`: main hazard behind the hex's aid. */
  hazard: number[];
  /** Index into `counties`, -1 = open water. */
  county: number[];
}

export interface County {
  fips: string;
  name: string;
  state: string;
  households: number;
  needPct: number;
  declared: boolean;
  eligible: number;
  aidUsd: number;
  femaApproved: number;
  femaDesignated: boolean;
}

export interface StormFile {
  version: 1;
  storm: Storm;
  trackStart: number;
  hazards: ("none" | "wind" | "rain" | "surge")[];
  projection: {
    eligibleHouseholds: number;
    potUsd: number;
    minAidUsd: number;
    maxAidUsd: number;
    medianAidUsd: number;
    declaredCounties: number;
    states: string[];
    byHazard: { group: string; households: number; totalUsd: number; meanAidUsd: number }[];
  };
  fema: {
    approvedHouseholds: number;
    approvedUsd: number;
    designatedCounties: number;
    designatedDeclared: number;
    capturedShare: number | null;
    payoutOverlap: number;
    heldOutOverlap: number | null;
    specRuleOverlap: number | null;
  };
  counties: County[];
  focus: { bounds: [[number, number], [number, number]]; rings: [number, number][][] };
  hexes: Record<string, HexColumns>;
}

export interface StormListing {
  slug: string;
  name: string;
  year: number;
}

export interface Timeline {
  start: number;
  end: number;
  trackEnd: number;
  landfall: number;
  /** Every US-or-elsewhere landfall on the best track. */
  landfalls: { t: number; lat: number; lon: number; vmax: number | null }[];
  /** Fraction of the bar given to the storm itself; recovery days share the rest. */
  split: number;
  timeZone: string;
}

export function buildTimeline(file: StormFile): Timeline {
  const d = timelineDomain(file.storm);
  return {
    start: d.start,
    end: d.end,
    trackEnd: d.trackEnd,
    landfall: d.landfall,
    landfalls: file.storm.landfalls,
    split: 0.62,
    timeZone: d.landfallLon < -85.5 ? "America/Chicago" : "America/New_York",
  };
}

/** Timeline time -> 0..1 along the bar (piecewise: storm days are wide, recovery days narrow). */
export function timeToFrac(tl: Timeline, t: number): number {
  if (t <= tl.trackEnd) return (tl.split * (t - tl.start)) / (tl.trackEnd - tl.start);
  return tl.split + ((1 - tl.split) * (t - tl.trackEnd)) / (tl.end - tl.trackEnd);
}

export function fracToTime(tl: Timeline, f: number): number {
  const x = Math.min(1, Math.max(0, f));
  if (x <= tl.split) return tl.start + (x / tl.split) * (tl.trackEnd - tl.start);
  return tl.trackEnd + ((x - tl.split) / (1 - tl.split)) * (tl.end - tl.trackEnd);
}

const cache = new Map<string, Promise<StormFile>>();

export function loadStorm(slug: string): Promise<StormFile> {
  let p = cache.get(slug);
  if (!p) {
    p = fetch(`/data/${slug}.json`).then((r) => {
      if (!r.ok) throw new Error(`storm ${slug}: ${r.status}`);
      return r.json() as Promise<StormFile>;
    });
    cache.set(slug, p);
  }
  return p;
}

export const DEMO_STORMS: StormListing[] = [
  { slug: "helene-2024", name: "Helene", year: 2024 },
  { slug: "ian-2022", name: "Ian", year: 2022 },
  { slug: "katrina-2005", name: "Katrina", year: 2005 },
];
