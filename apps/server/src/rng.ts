/** Seeded PRNG (mulberry32) so a storm's world and shopping are the same on every run. */
export class Rng {
  private s: number;

  constructor(seed: number | string) {
    this.s = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(lo: number, hiInclusive: number): number {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Exponential with the given mean. */
  exp(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }

  /** Index drawn in proportion to `weights`. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let x = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i]!;
      if (x < 0) return i;
    }
    return weights.length - 1;
  }
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
