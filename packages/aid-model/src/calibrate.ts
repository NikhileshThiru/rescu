import { type NeedParams, RAIN_KNOTS, soaked, WIND_KNOTS } from "./need.js";

/**
 * Fits the need model to real outcomes: for each county, expected FEMA approvals
 *
 *   approvals_c = kappa_storm x sum over tracts of households x need x (1 + eta x propensity)
 *
 * should match what FEMA approved. Two nuisance terms keep the hazard curves honest:
 * - kappa (one per storm, solved exactly each step) absorbs how generous FEMA was that year
 *   (Katrina's expedited aid, 2024's $750 grants), so the fit learns WHERE need was, not totals;
 * - eta absorbs FEMA's approval propensity (poorer, uninsured households get approved more), so
 *   it doesn't leak into the hazard or mobile-home weights. Neither is used for predictions.
 * Poisson loss, each storm weighted equally, weights non-negative and curves non-decreasing
 * (increments go through softplus), optimised with Adam.
 */

export interface TrainingTract {
  /** Index into the counties array. */
  county: number;
  /** Approval-propensity covariate (e.g. SVI, 0 to 1). Nuisance: used in fitting only. */
  propensity?: number;
  households: number;
  windKt: number;
  rainIn: number;
  surge: number;
  mobileShare: number;
}

export interface TrainingCounty {
  /** Which storm (0..n-1); each storm gets its own generosity factor. */
  storm: number;
  /** Households FEMA approved for assistance (owners + renters). */
  approved: number;
  /** Loss weight; 1 / (storm's total approved) makes every storm count equally. */
  weight: number;
}

export interface FitOptions {
  iterations?: number;
  learningRate?: number;
  /** L2 penalty on the curve increments (keeps curves smooth where data is thin). */
  l2?: number;
  windKnots?: number[];
  rainKnots?: number[];
  onProgress?: (iteration: number, loss: number) => void;
}

export interface FitResult {
  params: NeedParams;
  loss: number;
  iterations: number;
  /** FEMA generosity per storm (approvals per unit of modeled need). */
  stormScale: number[];
  /** Fitted approval-propensity effect (nuisance). */
  propensity: number;
}

const softplus = (u: number) => (u > 30 ? u : Math.log1p(Math.exp(u)));
const sigmoid = (u: number) => 1 / (1 + Math.exp(-u));
const inverseSoftplus = (x: number) => Math.log(Math.expm1(x));

/** Weights of each increment for value x: 1 for segments fully below x, the fraction for the one containing x. */
function basisInto(x: number, knots: number[], out: Float32Array, offset: number) {
  for (let j = 1; j < knots.length; j++) {
    const lo = knots[j - 1]!;
    const hi = knots[j]!;
    out[offset + j - 1] = x >= hi ? 1 : x > lo ? (x - lo) / (hi - lo) : 0;
  }
}

function cumulative(increments: number[]): number[] {
  const out = [0];
  for (const inc of increments) out.push(out[out.length - 1]! + inc);
  return out;
}

export function paramsFromIncrements(
  windInc: number[],
  rainInc: number[],
  surge: number,
  mobile: number,
  windRain = 0,
  windKnots = WIND_KNOTS,
  rainKnots = RAIN_KNOTS,
): NeedParams {
  return { windKnots, windValues: cumulative(windInc), rainKnots, rainValues: cumulative(rainInc), surge, mobile, windRain };
}

export function fitNeedModel(tracts: TrainingTract[], counties: TrainingCounty[], opts: FitOptions = {}): FitResult {
  const windKnots = opts.windKnots ?? WIND_KNOTS;
  const rainKnots = opts.rainKnots ?? RAIN_KNOTS;
  const nw = windKnots.length - 1;
  const nr = rainKnots.length - 1;
  const iterations = opts.iterations ?? 1_500;
  const lr = opts.learningRate ?? 0.05;
  const l2 = opts.l2 ?? 1e-4;

  const T = tracts.length;
  const BW = new Float32Array(T * nw);
  const BR = new Float32Array(T * nr);
  const H = new Float64Array(T);
  const S = new Float64Array(T);
  const M = new Float64Array(T);
  const C = new Int32Array(T);
  const Q = new Float64Array(T);
  const X = new Float64Array(T);
  tracts.forEach((t, i) => {
    Q[i] = t.propensity ?? 0;
    X[i] = soaked(t.windKt, t.rainIn);
    basisInto(t.windKt, windKnots, BW, i * nw);
    basisInto(t.rainIn, rainKnots, BR, i * nr);
    H[i] = t.households;
    S[i] = t.surge;
    M[i] = t.mobileShare;
    C[i] = t.county;
  });

  // u: unconstrained parameters -> [wind increments, rain increments, surge, mobile, eta, windRain]
  const P = nw + nr + 4;
  const u = new Float64Array(P).fill(inverseSoftplus(0.02));
  u[nw + nr + 1] = inverseSoftplus(0.5);
  u[nw + nr + 2] = inverseSoftplus(0.5);
  const storms = counties.reduce((n, c) => Math.max(n, c.storm + 1), 0);
  const stormApproved = new Float64Array(storms);
  for (const c of counties) stormApproved[c.storm] = stormApproved[c.storm]! + c.approved;
  const stormModel = new Float64Array(storms);
  const kappa = new Float64Array(storms);
  const m1 = new Float64Array(P);
  const m2 = new Float64Array(P);
  const grad = new Float64Array(P);
  const inc = new Float64Array(P);
  const A = new Float64Array(counties.length);
  const yhat = new Float64Array(counties.length);
  const dY = new Float64Array(counties.length);
  const W = new Float64Array(T);
  const E = new Float64Array(T);
  const eps = 1e-9;
  let loss = Infinity;

  for (let it = 1; it <= iterations; it++) {
    for (let k = 0; k < P; k++) inc[k] = softplus(u[k]!);
    const s = inc[nw + nr]!;
    const m = inc[nw + nr + 1]!;
    const eta = inc[nw + nr + 2]!;
    const wr = inc[nw + nr + 3]!;
    A.fill(0);
    for (let i = 0; i < T; i++) {
      let w = 0;
      let r = 0;
      for (let j = 0; j < nw; j++) w += BW[i * nw + j]! * inc[j]!;
      for (let j = 0; j < nr; j++) r += BR[i * nr + j]! * inc[nw + j]!;
      const lam = w * (1 + m * M[i]!) + r + s * S[i]! + wr * X[i]!;
      const e = Math.exp(-lam);
      W[i] = w;
      E[i] = e;
      A[C[i]!] = A[C[i]!]! + H[i]! * (1 - e) * (1 + eta * Q[i]!);
    }
    // Each storm's generosity, solved exactly (Poisson MLE): kappa = approved / modeled.
    stormModel.fill(0);
    for (let c = 0; c < counties.length; c++) stormModel[counties[c]!.storm] = stormModel[counties[c]!.storm]! + A[c]!;
    for (let k = 0; k < storms; k++) kappa[k] = stormModel[k]! > 0 ? stormApproved[k]! / stormModel[k]! : 1;
    loss = 0;
    for (let c = 0; c < counties.length; c++) {
      const { approved, weight, storm } = counties[c]!;
      const y = kappa[storm]! * A[c]! + eps;
      yhat[c] = y;
      loss += weight * (y - approved * Math.log(y));
      // kappa is at its optimum, so (envelope theorem) it can be held fixed for the gradient.
      dY[c] = weight * kappa[storm]! * (1 - approved / y);
    }
    grad.fill(0);
    for (let i = 0; i < T; i++) {
      const dA = dY[C[i]!]!;
      const prop = 1 + eta * Q[i]!;
      grad[nw + nr + 2] = grad[nw + nr + 2]! + dA * H[i]! * (1 - E[i]!) * Q[i]!;
      const g = dA * H[i]! * E[i]! * prop;
      if (g === 0) continue;
      const gw = g * (1 + m * M[i]!);
      for (let j = 0; j < nw; j++) grad[j] = grad[j]! + gw * BW[i * nw + j]!;
      for (let j = 0; j < nr; j++) grad[nw + j] = grad[nw + j]! + g * BR[i * nr + j]!;
      grad[nw + nr] = grad[nw + nr]! + g * S[i]!;
      grad[nw + nr + 1] = grad[nw + nr + 1]! + g * W[i]! * M[i]!;
      grad[nw + nr + 3] = grad[nw + nr + 3]! + g * X[i]!;
    }
    for (let k = 0; k < P; k++) {
      loss += l2 * inc[k]! * inc[k]!;
      const gk = (grad[k]! + 2 * l2 * inc[k]!) * sigmoid(u[k]!);
      m1[k] = 0.9 * m1[k]! + 0.1 * gk;
      m2[k] = 0.999 * m2[k]! + 0.001 * gk * gk;
      const mh = m1[k]! / (1 - 0.9 ** it);
      const vh = m2[k]! / (1 - 0.999 ** it);
      u[k] = u[k]! - (lr * mh) / (Math.sqrt(vh) + 1e-8);
    }
    if (opts.onProgress && (it % 100 === 0 || it === 1)) opts.onProgress(it, loss);
  }

  const finalInc = Array.from(u, softplus);
  return {
    stormScale: Array.from(kappa),
    propensity: finalInc[nw + nr + 2]!,
    params: paramsFromIncrements(
      finalInc.slice(0, nw),
      finalInc.slice(nw, nw + nr),
      finalInc[nw + nr]!,
      finalInc[nw + nr + 1]!,
      finalInc[nw + nr + 3]!,
      windKnots,
      rainKnots,
    ),
    loss,
    iterations,
  };
}

/**
 * How closely two distributions over the same counties agree: sum of min(share_a, share_b).
 * 1 = aid would be split exactly like FEMA's approvals; 0 = no overlap. Household-weighted,
 * unlike a rank correlation that counts a 500-home county the same as a 500,000-home one.
 */
export function distributionOverlap(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ta = 0;
  let tb = 0;
  for (let i = 0; i < a.length; i++) {
    ta += a[i]!;
    tb += b[i]!;
  }
  if (!ta || !tb) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.min(a[i]! / ta, b[i]! / tb);
  return s;
}

/** Spearman rank correlation (ties get average ranks). */
export function spearman(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const rank = (xs: ArrayLike<number>) => {
    const idx = Array.from({ length: xs.length }, (_, i) => i).sort((i, j) => xs[i]! - xs[j]!);
    const r = new Float64Array(xs.length);
    for (let k = 0; k < idx.length; ) {
      let e = k;
      while (e + 1 < idx.length && xs[idx[e + 1]!] === xs[idx[k]!]) e++;
      for (let q = k; q <= e; q++) r[idx[q]!] = (k + e) / 2;
      k = e + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = ra.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
