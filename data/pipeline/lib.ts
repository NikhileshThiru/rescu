import { readFileSync } from "node:fs";
import {
  allocate,
  type Allocation,
  type AllocationParams,
  DEFAULT_ALLOCATION,
  type Impact,
  impactsAt,
  sampleTrack,
  type Storm,
  type StormState,
} from "@rescu/aid-model";

export const OUT_DIR = new URL("../out/", import.meta.url);
export const REPO_ROOT = new URL("../../", import.meta.url);

export interface TractRow {
  geoid: string;
  stateAbbr: string;
  stateName: string;
  countyFips: string;
  countyName: string;
  lat: number;
  lon: number;
  population: number;
  households: number;
  svi: number;
  sviImputed: boolean;
  sviSocioeconomic: number | null;
  sviHousehold: number | null;
  sviMinority: number | null;
  sviHousing: number | null;
  pctPoverty: number | null;
  pctNoVehicle: number | null;
  pctAge65: number | null;
  pctDisability: number | null;
  pctLimitedEnglish: number | null;
  pctMobileHome: number | null;
}

/** Minimal RFC 4180 line split (Python's csv module quotes fields that contain commas). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const num = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));

export function readTracts(): TractRow[] {
  const [header, ...lines] = readFileSync(new URL("tracts.csv", OUT_DIR), "utf8").trim().split(/\r?\n/);
  const cols = splitCsv(header!);
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`tracts.csv is missing ${name}; rerun pnpm data:prep`);
    return i;
  };
  const c = Object.fromEntries(cols.map((n) => [n, at(n)]));
  return lines.map((line) => {
    const f = splitCsv(line);
    return {
      geoid: f[c.geoid!]!,
      stateAbbr: f[c.state_abbr!]!,
      stateName: f[c.state_name!]!,
      countyFips: f[c.county_fips!]!,
      countyName: f[c.county_name!]!,
      lat: Number(f[c.lat!]),
      lon: Number(f[c.lon!]),
      population: Number(f[c.population!]),
      households: Number(f[c.households!]),
      svi: Number(f[c.svi!]),
      sviImputed: f[c.svi_imputed!] === "True",
      sviSocioeconomic: num(f[c.svi_socioeconomic!]),
      sviHousehold: num(f[c.svi_household!]),
      sviMinority: num(f[c.svi_minority!]),
      sviHousing: num(f[c.svi_housing!]),
      pctPoverty: num(f[c.pct_poverty!]),
      pctNoVehicle: num(f[c.pct_no_vehicle!]),
      pctAge65: num(f[c.pct_age65!]),
      pctDisability: num(f[c.pct_disability!]),
      pctLimitedEnglish: num(f[c.pct_limited_english!]),
      pctMobileHome: num(f[c.pct_mobile_home!]),
    };
  });
}

export function readStorms(): Storm[] {
  return JSON.parse(readFileSync(new URL("storms.json", OUT_DIR), "utf8")) as Storm[];
}

export interface StormRun {
  storm: Storm;
  states: StormState[];
  impacts: Impact[];
  allocation: Allocation;
  ms: number;
}

export function runStorm(storm: Storm, tracts: TractRow[], params: AllocationParams = DEFAULT_ALLOCATION): StormRun {
  const t0 = performance.now();
  const states = sampleTrack(storm, 600);
  const impacts = impactsAt(states, tracts);
  const allocation = allocate(
    tracts.map((t, i) => ({ households: t.households, svi: t.svi, band: impacts[i]!.band })),
    params,
  );
  return { storm, states, impacts, allocation, ms: performance.now() - t0 };
}
