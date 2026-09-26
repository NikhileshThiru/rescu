import { allocate, autoDeclareCounties, DEFAULT_NEED_MODEL, type Storm } from "@rescu/aid-model";
import { aidArrival, type MerchantCategory, type PlantedKind, timelineDomain } from "@rescu/live";
import { latLngToCell } from "h3-js";
import { merchantName } from "./names.js";
import { Rng } from "./rng.js";

/** A census tract with the storm's modeled need (from Tiger). */
export interface TractInput {
  geoid: string;
  countyFips: string;
  countyName: string;
  state: string;
  lat: number;
  lon: number;
  households: number;
  population: number;
  svi: number;
  need: number;
}

/** The parts of the web app's storm file the sim uses (apps/web/public/data/<slug>.json). */
export interface StormInput {
  storm: Storm;
  trackStart: number;
  projection: { eligibleHouseholds: number; potUsd: number };
  hexes: Record<string, { h3: string[]; kt: number[]; t34: number[]; peak: number[]; rainIn: number[] }>;
}

export const CATEGORIES: MerchantCategory[] = ["pharmacy", "grocery", "hardware", "general"];
const CATEGORY_WEIGHTS = [0.2, 0.32, 0.2, 0.28];
/** Nearest stores remembered per household, per category. */
export const NEAR_K = 3;
/** Rule-breakers: try a generator over the order cap, a buying spree past the daily cap, an unregistered store, or reselling aid. */
export const ROGUE = { none: 0, generator: 1, spree: 2, unregistered: 3, resale: 4 } as const;
/**
 * Planted fraud the chain can't see (the oracle's job, not the transfer hook's): several
 * households registered with the same device/phone/address, residents trading aid for cash at a
 * colluding store, and residents who spend unusually fast. Planted in `buildWorld`.
 */
export const FRAUD = { none: 0, duplicate: 1, collusion: 2, velocity: 3 } as const;

/** Ground truth for the oracle's scorecard (`GET /api/oracle/metrics`). Never shown as a hint in the UI. */
export interface Planted {
  kind: PlantedKind;
  merchants: number[];
  residents: number[];
}

export interface World {
  slug: string;
  stormName: string;
  storm: Storm;
  domain: ReturnType<typeof timelineDomain>;
  fullScale: { eligibleHouseholds: number; potCents: number; eligiblePopulation: number; declaredCounties: number };
  budgetCents: number;
  counties: Map<string, { name: string; state: string }>;
  households: {
    n: number;
    geoid: string[];
    county: string[];
    h3: string[];
    lon: Float64Array;
    lat: Float64Array;
    aidCents: Int32Array;
    /** Sim time the storm reaches the household's hex. */
    aidDue: Float64Array;
    size: Uint8Array;
    kids: Uint8Array;
    pet: Uint8Array;
    svi: Float32Array;
    rogue: Uint8Array;
    /** NEAR_K nearest merchant indices per category (CATEGORIES order), -1 = none. */
    near: Int16Array;
    /** "Maria G." (deterministic per storm). */
    name: string[];
    /** Mock ID check at registration: device id, phone, street address. Planted duplicates share one. */
    device: string[];
    phone: string[];
    address: string[];
    /** FRAUD kind per household (0 = honest). */
    fraud: Uint8Array;
    /** Collusion: the store this household trades its aid at, -1 = none. */
    colludeWith: Int16Array;
  };
  merchants: {
    n: number;
    name: string[];
    category: MerchantCategory[];
    county: string[];
    h3: string[];
    lon: Float64Array;
    lat: Float64Array;
    /** Closed by the storm from/until these sim times; NaN = never closed. */
    closedFrom: Float64Array;
    reopensAt: Float64Array;
    /** Planted gouging: price multiplier (1 = honest) applied from `gougeFrom` (sim time, NaN = never). */
    gouge: Float32Array;
    gougeFrom: Float64Array;
  };
  /** Eligible tracts (for "I live here": the aid a new registration at that spot gets). */
  tracts: { geoid: string; county: string; lat: number; lon: number; cents: number; households: number }[];
  /** When aid is due at a res-5 hex (the storm's arrival), unix seconds. */
  aidDueAt: (h3: string) => number;
  planted: Planted[];
}

function jitter(rng: Rng, lat: number, lon: number, km: number): [number, number] {
  const r = km * Math.sqrt(rng.next());
  const a = rng.next() * 2 * Math.PI;
  return [lat + (r * Math.cos(a)) / 111, lon + (r * Math.sin(a)) / (111 * Math.cos((lat * Math.PI) / 180))];
}

/**
 * The sim's population for one storm: households sampled from the model's full-scale allocation
 * (proportional to households, each keeping its tract's exact aid amount, so the on-chain run
 * has the same distribution as the map) and stores placed where people live.
 */
export function buildWorld(input: StormInput, tracts: TractInput[], opts: { households: number; merchantsMax: number; seed: string }): World {
  const rng = new Rng(`world:${input.storm.slug}:${opts.seed}`);
  const domain = timelineDomain(input.storm);
  const need = tracts.map((t) => t.need);
  const declared = autoDeclareCounties(tracts, need, DEFAULT_NEED_MODEL.declareThreshold);
  const alloc = allocate(tracts.map((t) => ({ households: t.households, svi: t.svi, need: t.need, declared: declared.has(t.countyFips) })));

  const counties = new Map<string, { name: string; state: string }>();
  for (const t of tracts) if (!counties.has(t.countyFips)) counties.set(t.countyFips, { name: t.countyName, state: t.state });

  // Storm timing per res-5 hex, exactly as the map reads it.
  const hex5 = input.hexes["5"];
  if (!hex5) throw new Error("storm file has no res-5 hexes");
  const hexIndex = new Map(hex5.h3.map((h, i) => [h, i]));
  const abs = (m: number) => (m < 0 ? -1 : input.trackStart + m * 60);
  const arrivalOf = (h3: string) => {
    const i = hexIndex.get(h3);
    return i === undefined ? aidArrival(-1, -1, domain.landfall) : aidArrival(abs(hex5.t34[i]!), abs(hex5.peak[i]!), domain.landfall);
  };

  // Systematic sample of eligible households: every (eligible / n)-th household in geoid order.
  const eligible = tracts.map((t, i) => ({ t, i })).filter(({ i }) => alloc.score[i]! > 0);
  eligible.sort((a, b) => (a.t.geoid < b.t.geoid ? -1 : 1));
  const n = Math.min(opts.households, alloc.eligibleHouseholds);
  const step = alloc.eligibleHouseholds / Math.max(1, n);
  const picks: number[] = [];
  let next = rng.next() * step;
  let cum = 0;
  for (const { t, i } of eligible) {
    const end = cum + t.households;
    while (next < end && picks.length < n) {
      picks.push(i);
      next += step;
    }
    cum = end;
  }

  const H = {
    n: picks.length,
    geoid: [] as string[],
    county: [] as string[],
    h3: [] as string[],
    lon: new Float64Array(picks.length),
    lat: new Float64Array(picks.length),
    aidCents: new Int32Array(picks.length),
    aidDue: new Float64Array(picks.length),
    size: new Uint8Array(picks.length),
    kids: new Uint8Array(picks.length),
    pet: new Uint8Array(picks.length),
    svi: new Float32Array(picks.length),
    rogue: new Uint8Array(picks.length),
    near: new Int16Array(picks.length * CATEGORIES.length * NEAR_K).fill(-1),
    name: [] as string[],
    device: [] as string[],
    phone: [] as string[],
    address: [] as string[],
    fraud: new Uint8Array(picks.length),
    colludeWith: new Int16Array(picks.length).fill(-1),
  };
  let budgetCents = 0;
  picks.forEach((ti, k) => {
    const t = tracts[ti]!;
    const h3 = latLngToCell(t.lat, t.lon, 5);
    const [lat, lon] = jitter(rng, t.lat, t.lon, 1.2);
    H.geoid.push(t.geoid);
    H.county.push(t.countyFips);
    H.h3.push(h3);
    H.lat[k] = lat;
    H.lon[k] = lon;
    H.aidCents[k] = alloc.cents[ti]!;
    budgetCents += alloc.cents[ti]!;
    H.aidDue[k] = arrivalOf(h3);
    const avg = t.households > 0 ? t.population / t.households : 2.5;
    const size = Math.max(1, Math.min(7, Math.round(avg + rng.range(-1.2, 1.8))));
    H.size[k] = size;
    H.kids[k] = rng.chance(size >= 3 ? 0.55 : size === 2 ? 0.12 : 0) ? 1 : 0;
    H.pet[k] = rng.chance(0.35) ? 1 : 0;
    H.svi[k] = t.svi;
    if (rng.chance(0.01)) H.rogue[k] = 1 + rng.int(0, 3);
    H.name.push(residentName(rng));
    H.device.push(`dev_${hex(rng, 12)}`);
    // Unique per household (planted duplicates are copied over later), so only planted fraud ever matches.
    H.phone.push(fakePhone(k));
    H.address.push(`${100 + ((k * 7919) % 99991)} ${STREETS[k % STREETS.length]}, ${t.countyName.replace(/ (County|Parish)$/, "")} ${t.state}`);
  });

  // Stores: ~1 per 8,000 residents of the aid area, placed by population in declared counties.
  let eligiblePopulation = 0;
  for (const { t } of eligible) eligiblePopulation += t.population;
  const mCount = Math.max(8, Math.min(opts.merchantsMax, Math.round(eligiblePopulation / 8000)));
  const inDeclared = tracts.filter((t) => declared.has(t.countyFips) && t.population > 0);
  if (!inDeclared.length) throw new Error(`${input.storm.slug}: no declared counties (no tract impacts loaded for ${input.storm.id}?)`);
  const cumPop: number[] = [];
  let pop = 0;
  for (const t of inDeclared) cumPop.push((pop += t.population));
  const M = {
    n: mCount,
    name: [] as string[],
    category: [] as MerchantCategory[],
    county: [] as string[],
    h3: [] as string[],
    lon: new Float64Array(mCount),
    lat: new Float64Array(mCount),
    closedFrom: new Float64Array(mCount).fill(Number.NaN),
    reopensAt: new Float64Array(mCount).fill(Number.NaN),
    gouge: new Float32Array(mCount).fill(1),
    gougeFrom: new Float64Array(mCount).fill(Number.NaN),
  };
  const taken = new Set<string>();
  for (let m = 0; m < mCount; m++) {
    const x = rng.next() * pop;
    let lo = 0;
    let hi = cumPop.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumPop[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    const t = inDeclared[lo]!;
    const category = CATEGORIES[rng.weighted(CATEGORY_WEIGHTS)]!;
    const [lat, lon] = jitter(rng, t.lat, t.lon, 1.5);
    const h3 = latLngToCell(t.lat, t.lon, 5);
    M.name.push(merchantName(rng, category, t.countyName, taken));
    M.category.push(category);
    M.county.push(t.countyFips);
    M.h3.push(h3);
    M.lat[m] = lat;
    M.lon[m] = lon;
    // Stores in the worst wind or flooding close when the storm arrives and reopen days later.
    const hi5 = hexIndex.get(h3);
    if (hi5 !== undefined) {
      const kt = hex5.kt[hi5]!;
      const rain = hex5.rainIn[hi5]!;
      const arrive = arrivalOf(h3);
      let days = 0;
      if (kt >= 96) days = rng.range(4, 8);
      else if (kt >= 64) days = rng.range(2, 5);
      else if (kt >= 50) days = rng.range(0.5, 2);
      else if (kt >= 34) days = rng.range(0.25, 0.75);
      if (rain >= 12) days += rng.range(1, 3);
      if (days > 0) {
        M.closedFrom[m] = arrive - 6 * 3600;
        M.reopensAt[m] = arrive + days * 86400;
      }
    }
  }

  // Nearest NEAR_K stores of each category for every household (equirectangular distance).
  const C = CATEGORIES.length;
  const bestD = new Float64Array(C * NEAR_K);
  for (let h = 0; h < H.n; h++) {
    bestD.fill(Infinity);
    const k = Math.cos((H.lat[h]! * Math.PI) / 180);
    const base = h * C * NEAR_K;
    for (let m = 0; m < M.n; m++) {
      const c = CATEGORIES.indexOf(M.category[m]!);
      const dx = (M.lon[m]! - H.lon[h]!) * k;
      const dy = M.lat[m]! - H.lat[h]!;
      const d = dx * dx + dy * dy;
      const o = c * NEAR_K;
      if (d >= bestD[o + NEAR_K - 1]!) continue;
      let j = NEAR_K - 1;
      while (j > 0 && bestD[o + j - 1]! > d) {
        bestD[o + j] = bestD[o + j - 1]!;
        H.near[base + o + j] = H.near[base + o + j - 1]!;
        j--;
      }
      bestD[o + j] = d;
      H.near[base + o + j] = m;
    }
  }

  // Planted bad actors for the oracle (gougers, duplicate registrations, collusion, velocity).
  const planted: Planted[] = [];

  return {
    slug: input.storm.slug,
    stormName: `${input.storm.name} ${input.storm.year}`,
    storm: input.storm,
    domain,
    fullScale: { eligibleHouseholds: alloc.eligibleHouseholds, potCents: alloc.potCents, eligiblePopulation, declaredCounties: declared.size },
    budgetCents,
    counties,
    households: H,
    merchants: M,
    tracts: eligible.map(({ t, i }) => ({ geoid: t.geoid, county: t.countyFips, lat: t.lat, lon: t.lon, cents: alloc.cents[i]!, households: t.households })),
    aidDueAt: arrivalOf,
    planted,
  };
}

const FIRST = [
  "Maria", "James", "Rosa", "Darnell", "Linda", "Tyrone", "Carmen", "Earl", "Keisha", "Tom", "Brenda", "Luis", "Denise",
  "Marcus", "Patricia", "Andre", "Grace", "Jamal", "Nancy", "Carlos", "Shirley", "Dwayne", "Ana", "Harold", "Tasha",
  "Wei", "Priya", "Hector", "Ruth", "Omar", "Latoya", "Bill", "Yolanda", "Miguel", "Joan", "Terrence", "Nguyen", "Faith",
];
const STREETS = ["Oak St", "Pine Ave", "Magnolia Dr", "Cypress Ln", "Church St", "Main St", "River Rd", "Pecan Way", "Dogwood Ct", "Live Oak Blvd", "Bay St", "Palmetto Ave"];
const LETTERS = "ABCDEFGHJKLMNPRSTVW";

function residentName(rng: Rng): string {
  return `${rng.pick(FIRST)} ${LETTERS[rng.int(0, LETTERS.length - 1)]}.`;
}

function hex(rng: Rng, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += rng.int(0, 15).toString(16);
  return s;
}

const AREA_CODES = ["229", "352", "850", "912", "828", "706", "239", "504", "228"];

/** Fictional 555 numbers, unique for the first 90,000 households. */
function fakePhone(k: number): string {
  return `(${AREA_CODES[k % AREA_CODES.length]}) 555-${String(Math.floor(k / AREA_CODES.length) % 10_000).padStart(4, "0")}`;
}

export function isOpen(w: World, m: number, t: number): boolean {
  const from = w.merchants.closedFrom[m]!;
  return Number.isNaN(from) || t < from || t >= w.merchants.reopensAt[m]!;
}

export function countyLabel(w: World, fips: string): string {
  const c = w.counties.get(fips);
  return c ? `${c.name.replace(/ (County|Parish)$/, "")}, ${c.state}` : fips;
}
