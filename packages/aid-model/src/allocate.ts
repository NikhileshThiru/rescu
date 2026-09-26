import type { Band } from "./types";

export interface AllocationParams {
  /** Average aid per eligible household, dollars. The pot is eligible households x this. */
  meanAid: number;
  minAid: number;
  maxAid: number;
  /**
   * Tracts whose need (share of households expected to need help) is below this get nothing.
   * 2% was the best cutoff on the 20 training storms (dollar split closest to FEMA's approvals);
   * lower pays whole big cities on a storm's edge, higher drops wide storm-soaked areas.
   */
  minNeed: number;
  /** Vulnerability multiplier = sviBase + sviSlope x SVI (0.7 to 1.3 by default). A policy choice. */
  sviBase: number;
  sviSlope: number;
}

export const DEFAULT_ALLOCATION: AllocationParams = {
  meanAid: 1_000,
  minAid: 250,
  maxAid: 2_000,
  minNeed: 0.02,
  sviBase: 0.7,
  sviSlope: 0.6,
};

export interface AllocationInput {
  households: number;
  svi: number;
  /** Expected share of households needing help, 0 to 1 (need.ts). */
  need: number;
  /** Inside the declared disaster area. Default true. */
  declared?: boolean;
  /**
   * Floor on need for counties an official added by hand (the model missed the hazard there,
   * e.g. a landslide), so their households still qualify.
   */
  needFloor?: number;
}

/** The spec's original band weights (34 / 50 / 64 kt / major), kept as a baseline to compare against. */
export const SPEC_WIND_FACTOR: Record<Exclude<Band, 0>, number> = { 1: 0.3, 2: 0.6, 3: 1.0, 4: 1.5 };
export const specNeed = (band: Band) => (band === 0 ? 0 : SPEC_WIND_FACTOR[band]);

export interface Allocation {
  /** Per tract: base aid per household in cents (0 = not eligible). */
  cents: Int32Array;
  /** Per tract: how many of its households get one extra cent, so the total hits the pot exactly. */
  extraCent: Int32Array;
  /** Per tract: the score s = need x (sviBase + sviSlope x SVI). */
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

/** Allocation score for one tract (need x vulnerability); 0 if it doesn't qualify. */
export function needScore(t: AllocationInput, p: AllocationParams): number {
  if (t.declared === false || t.households <= 0) return 0;
  const need = Math.max(t.need, t.needFloor ?? 0);
  if (need < p.minNeed) return 0;
  return need * (p.sviBase + p.sviSlope * t.svi);
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
  /** Totals per caller-supplied group (e.g. dominant hazard or wind band). */
  byGroup: { group: string; households: number; totalUsd: number; meanAidUsd: number }[];
}

export function summarize(tracts: AllocationInput[], a: Allocation, groups?: string[]): AllocationSummary {
  const byGroup = new Map<string, { households: number; cents: number }>();
  const perHousehold: { aid: number; households: number }[] = [];
  let min = Infinity;
  let max = 0;
  let totalCents = 0;
  tracts.forEach((t, i) => {
    if (a.score[i]! <= 0) return;
    const c = tractTotalCents(a, i, t.households);
    totalCents += c;
    const key = groups?.[i] ?? "all";
    const g = byGroup.get(key) ?? { households: 0, cents: 0 };
    g.households += t.households;
    g.cents += c;
    byGroup.set(key, g);
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
    byGroup: [...byGroup.entries()]
      .sort((x, y) => y[1].households - x[1].households)
      .map(([group, v]) => ({ group, households: v.households, totalUsd: v.cents / 100, meanAidUsd: v.cents / v.households / 100 })),
  };
}
