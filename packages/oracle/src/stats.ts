/** Robust statistics: medians and MAD instead of means and standard deviations, so a few bad actors can't drag the baseline. */

/** Median of the finite values (NaN for none). Does not modify the input. */
export function median(xs: ArrayLike<number>): number {
  const a: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    if (Number.isFinite(v)) a.push(v);
  }
  if (!a.length) return Number.NaN;
  a.sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** Median absolute deviation from the median. */
export function mad(xs: ArrayLike<number>, med = median(xs)): number {
  const d: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i]!;
    if (Number.isFinite(v)) d.push(Math.abs(v - med));
  }
  return median(d);
}

export interface RobustStats {
  median: number;
  mad: number;
}

export function robustStats(xs: ArrayLike<number>): RobustStats {
  const m = median(xs);
  return { median: m, mad: mad(xs, m) };
}

/**
 * Robust z-score: (x - median) / (1.4826 * MAD), the MAD scaled to match a standard deviation
 * for normal data. `floor` keeps a near-constant population (MAD 0) from turning every tiny
 * difference into an infinite z.
 */
export function robustZ(x: number, s: RobustStats, floor = 1e-6): number {
  if (!Number.isFinite(x) || !Number.isFinite(s.median)) return 0;
  const scale = Math.max(1.4826 * s.mad, floor);
  return (x - s.median) / scale;
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const clamp01 = (x: number) => clamp(x, 0, 1);

/** Rounds to `d` decimals (for features and wire payloads). */
export const round = (x: number, d = 2) => {
  const k = 10 ** d;
  return Math.round(x * k) / k;
};

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Small deterministic PRNG (mulberry32), so the forest is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
