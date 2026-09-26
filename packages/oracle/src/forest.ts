/**
 * Isolation forest (Liu, Ting & Zhou 2008) in plain TypeScript. Anomalies are few and different,
 * so random axis-aligned splits isolate them in fewer steps than normal points. Each tree is
 * grown on a random subsample; a point's anomaly score is 2^(-E[h(x)] / c(psi)), where h is its
 * path length and c(n) the average path length of an unsuccessful BST search over n points.
 * ~0.5 = ordinary, -> 1 = isolated almost at once.
 */
import { mulberry32 } from "./stats";

const EULER = 0.5772156649015329;

/** Average path length of an unsuccessful search in a BST of n points (the normaliser). */
export function cFactor(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
}

type Node = { leaf: true; size: number } | { leaf: false; feature: number; split: number; left: Node; right: Node };

export interface ForestOptions {
  trees?: number;
  sampleSize?: number;
  seed?: number;
}

export class IsolationForest {
  readonly trees: number;
  readonly sampleSize: number;
  private readonly seed: number;
  private roots: Node[] = [];
  private psi = 0;
  /** Rows the forest was fit on. */
  trainedOn = 0;
  dims = 0;

  constructor(opts: ForestOptions = {}) {
    this.trees = opts.trees ?? 100;
    this.sampleSize = opts.sampleSize ?? 256;
    this.seed = opts.seed ?? 42;
  }

  get fitted() {
    return this.roots.length > 0;
  }

  fit(rows: number[][]): this {
    const n = rows.length;
    this.trainedOn = n;
    this.roots = [];
    if (!n) return this;
    this.dims = rows[0]!.length;
    const rand = mulberry32(this.seed);
    this.psi = Math.min(this.sampleSize, n);
    const limit = Math.ceil(Math.log2(Math.max(2, this.psi)));
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let t = 0; t < this.trees; t++) {
      // Partial Fisher-Yates: the first psi indices are a uniform sample without replacement.
      for (let i = 0; i < this.psi; i++) {
        const j = i + Math.floor(rand() * (n - i));
        const tmp = idx[i]!;
        idx[i] = idx[j]!;
        idx[j] = tmp;
      }
      this.roots.push(this.grow(rows, idx.slice(0, this.psi), 0, limit, rand));
    }
    return this;
  }

  private grow(rows: number[][], sample: number[], depth: number, limit: number, rand: () => number): Node {
    if (depth >= limit || sample.length <= 1) return { leaf: true, size: sample.length };
    // Only features that still vary in this sample can split it.
    const candidates: { f: number; lo: number; hi: number }[] = [];
    for (let f = 0; f < this.dims; f++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const i of sample) {
        const v = rows[i]![f]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi > lo) candidates.push({ f, lo, hi });
    }
    if (!candidates.length) return { leaf: true, size: sample.length };
    const c = candidates[Math.floor(rand() * candidates.length)]!;
    const split = c.lo + rand() * (c.hi - c.lo);
    const left: number[] = [];
    const right: number[] = [];
    for (const i of sample) (rows[i]![c.f]! < split ? left : right).push(i);
    return { leaf: false, feature: c.f, split, left: this.grow(rows, left, depth + 1, limit, rand), right: this.grow(rows, right, depth + 1, limit, rand) };
  }

  /** Path length of x in one tree, with the c(size) estimate for the unexpanded leaf. */
  private path(node: Node, x: number[], depth: number): number {
    let n = node;
    let d = depth;
    while (!n.leaf) {
      n = (x[n.feature] ?? 0) < n.split ? n.left : n.right;
      d++;
    }
    return d + cFactor(n.size);
  }

  /** Mean path length over the trees. */
  depth(x: number[]): number {
    if (!this.roots.length) return 0;
    let sum = 0;
    for (const r of this.roots) sum += this.path(r, x, 0);
    return sum / this.roots.length;
  }

  /** Anomaly score in (0, 1]: ~0.5 ordinary, near 1 very anomalous. 0 before fitting. */
  score(x: number[]): number {
    if (!this.roots.length) return 0;
    const c = cFactor(this.psi);
    if (c <= 0) return 0.5;
    return 2 ** (-this.depth(x) / c);
  }
}
