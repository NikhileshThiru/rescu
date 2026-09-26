import type { Band } from "./types.js";

export interface AllocationParams {
  /** Average aid per eligible household, dollars. The pot is eligible households x this. */
  meanAid: number;
  minAid: number;
  maxAid: number;
  /** Lowest wind band that qualifies (1 = 34 kt tropical storm, 2 = 50 kt, 3 = hurricane). */
  minBand: Exclude<Band, 0>;
  /** Weight per band: 34 kt, 50 kt, 64 kt, major core. */
  windFactor: Record<Exclude<Band, 0>, number>;
  /** Vulnerability multiplier = sviBase + sviSlope x SVI (0.7 to 1.3 by default). */
  sviBase: number;
  sviSlope: number;
  /**
   * Inside a declared county, tracts whose modeled wind falls below `minBand` still qualify at
   * this band: a FEMA designation means damage was confirmed (e.g. Helene's flooding in western
   * North Carolina, which a wind model can't see). null disables it.
   */
  declaredFloorBand: Exclude<Band, 0> | null;
}

export const DEFAULT_ALLOCATION: AllocationParams = {
  meanAid: 1_000,
  minAid: 250,
  maxAid: 2_000,
  minBand: 1,
  windFactor: { 1: 0.3, 2: 0.6, 3: 1.0, 4: 1.5 },
  sviBase: 0.7,
  sviSlope: 0.6,
  declaredFloorBand: 1,
};

export interface AllocationInput {
  households: number;
  svi: number;
  band: Band;
  /** Inside the declared disaster area (e.g. a FEMA Individual Assistance county). Default true. */
  declared?: boolean;
}

export interface Allocation {
  /** Per tract: base aid per household in cents (0 = not eligible). */
  cents: Int32Array;
  /** Per tract: how many of its households get one extra cent, so the total hits the pot exactly. */
  extraCent: Int32Array;
  /** Per tract: the need score s = wind factor x (sviBase + sviSlope x SVI). */
  score: Float64Array;
  eligibleHouseholds: number;
  eligibleTracts: number;
  /** Pot in cents = eligible households x mean aid. Always equals the allocated total. */
  potCents: number;
  /** Solved scale: aid per household = clamp(lambda x score, min, max). */
  lambda: number;
  householdsAtMin: number;
  householdsAtMax: number;
}

/** Need score for one tract; 0 if it doesn't qualify. */
export function needScore(t: AllocationInput, p: AllocationParams): number {
  if (t.declared === false || t.households <= 0) return 0;
  const band = t.declared === true && p.declaredFloorBand !== null ? Math.max(t.band, p.declaredFloorBand) : t.band;
  if (band < p.minBand) return 0;
  return p.windFactor[band as Exclude<Band, 0>] * (p.sviBase + p.sviSlope * t.svi);
}

/**
 * Splits a pot of (eligible households x mean aid) in proportion to need, clamped to
 * [minAid, maxAid] with the clamped remainder redistributed to everyone else.
 *
 * The "clamp and redistribute until stable" fixed point is exactly aid = clamp(lambda x s),
 * with lambda chosen so the total equals the pot. That total only grows with lambda, so a
 * bisection finds it; no iteration order to get wrong. Computed on tracts, so hex size never
 * changes anyone's aid.
 */
export function allocate(tracts: AllocationInput[], params: AllocationParams = DEFAULT_ALLOCATION): Allocation {
  const n = tracts.length;
  const score = new Float64Array(n);
  let eligibleHouseholds = 0;
  let eligibleTracts = 0;
  let minScore = Infinity;
  for (let i = 0; i < n; i++) {
    const s = needScore(tracts[i]!, params);
    score[i] = s;
    if (s > 0) {
      eligibleHouseholds += tracts[i]!.households;
      eligibleTracts++;
      minScore = Math.min(minScore, s);
    }
  }

  const cents = new Int32Array(n);
  const extraCent = new Int32Array(n);
  const potCents = eligibleHouseholds * Math.round(params.meanAid * 100);
  if (eligibleHouseholds === 0) {
    return { cents, extraCent, score, eligibleHouseholds, eligibleTracts, potCents, lambda: 0, householdsAtMin: 0, householdsAtMax: 0 };
  }

  const aid = (lambda: number, s: number) => Math.min(params.maxAid, Math.max(params.minAid, lambda * s));
  const total = (lambda: number) => {
    let sum = 0;
    for (let i = 0; i < n; i++) if (score[i]! > 0) sum += tracts[i]!.households * aid(lambda, score[i]!);
    return sum;
  };
  const pot = potCents / 100;
  let lo = 0;
  let hi = params.maxAid / minScore;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (total(mid) < pot) lo = mid;
    else hi = mid;
  }
  const lambda = (lo + hi) / 2;

  // Floor to cents, then hand the leftover cents one per household to the largest remainders.
  const remainders: { i: number; r: number }[] = [];
  let allocated = 0;
  let householdsAtMin = 0;
  let householdsAtMax = 0;
  for (let i = 0; i < n; i++) {
    if (score[i]! <= 0) continue;
    const exact = aid(lambda, score[i]!) * 100;
    const base = Math.floor(exact + 1e-9);
    cents[i] = base;
    allocated += base * tracts[i]!.households;
    const r = exact - base;
    if (r > 1e-9) remainders.push({ i, r });
    if (base <= params.minAid * 100) householdsAtMin += tracts[i]!.households;
    if (base >= params.maxAid * 100) householdsAtMax += tracts[i]!.households;
  }
  remainders.sort((a, b) => b.r - a.r);
  let leftover = potCents - allocated;
  for (const { i } of remainders) {
    if (leftover <= 0) break;
    const give = Math.min(leftover, tracts[i]!.households);
    extraCent[i] = give;
    leftover -= give;
  }
  // Floating-point bisection can leave a cent or two of slack; settle it on the largest tract
  // strictly inside the bounds so no household crosses min or max.
  if (leftover !== 0) {
    let best = -1;
    for (let i = 0; i < n; i++) {
      const inside = cents[i]! > params.minAid * 100 && cents[i]! + 1 < params.maxAid * 100;
      if (score[i]! > 0 && inside && (best < 0 || tracts[i]!.households > tracts[best]!.households)) best = i;
    }
    if (best >= 0) extraCent[best] = extraCent[best]! + leftover;
  }

  return { cents, extraCent, score, eligibleHouseholds, eligibleTracts, potCents, lambda, householdsAtMin, householdsAtMax };
}

/** Total cents a tract receives. */
export function tractTotalCents(a: Allocation, i: number, households: number): number {
  return a.cents[i]! * households + a.extraCent[i]!;
}

export interface AllocationSummary {
  eligibleHouseholds: number;
  eligibleTracts: number;
  potUsd: number;
  meanAidUsd: number;
  minAidUsd: number;
  maxAidUsd: number;
  medianAidUsd: number;
  householdsAtMin: number;
  householdsAtMax: number;
  byBand: { band: Band; households: number; totalUsd: number; meanAidUsd: number }[];
}

export function summarize(tracts: AllocationInput[], a: Allocation): AllocationSummary {
  const byBand = new Map<Band, { households: number; cents: number }>();
  const perHousehold: { aid: number; households: number }[] = [];
  let min = Infinity;
  let max = 0;
  let totalCents = 0;
  tracts.forEach((t, i) => {
    if (a.score[i]! <= 0) return;
    const c = tractTotalCents(a, i, t.households);
    totalCents += c;
    const b = byBand.get(t.band) ?? { households: 0, cents: 0 };
    b.households += t.households;
    b.cents += c;
    byBand.set(t.band, b);
    min = Math.min(min, a.cents[i]!);
    max = Math.max(max, a.cents[i]! + (a.extraCent[i]! > 0 ? 1 : 0));
    perHousehold.push({ aid: a.cents[i]!, households: t.households });
  });
  perHousehold.sort((x, y) => x.aid - y.aid);
  let seen = 0;
  let median = 0;
  for (const p of perHousehold) {
    seen += p.households;
    if (seen >= a.eligibleHouseholds / 2) {
      median = p.aid;
      break;
    }
  }
  return {
    eligibleHouseholds: a.eligibleHouseholds,
    eligibleTracts: a.eligibleTracts,
    potUsd: a.potCents / 100,
    meanAidUsd: a.eligibleHouseholds ? totalCents / a.eligibleHouseholds / 100 : 0,
    minAidUsd: min === Infinity ? 0 : min / 100,
    maxAidUsd: max / 100,
    medianAidUsd: median / 100,
    householdsAtMin: a.householdsAtMin,
    householdsAtMax: a.householdsAtMax,
    byBand: [...byBand.entries()]
      .sort(([x], [y]) => x - y)
      .map(([band, v]) => ({ band, households: v.households, totalUsd: v.cents / 100, meanAidUsd: v.cents / v.households / 100 })),
  };
}
