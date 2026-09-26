/** Binary min-heap of (time, household) pairs in typed arrays; stale entries are skipped by the caller. */
export class TimeHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(Math.max(16, capacity));
    this.vals = new Int32Array(Math.max(16, capacity));
  }

  push(key: number, val: number) {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      const v = new Int32Array(this.size * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.keys[i] = this.keys[p]!;
      this.vals[i] = this.vals[p]!;
      i = p;
    }
    this.keys[i] = key;
    this.vals[i] = val;
  }

  peekKey(): number {
    return this.size ? this.keys[0]! : Infinity;
  }

  /** Removes the smallest entry; returns [key, val]. */
  pop(): [number, number] {
    const key = this.keys[0]!;
    const val = this.vals[0]!;
    const lastK = this.keys[--this.size]!;
    const lastV = this.vals[this.size]!;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const c = r < this.size && this.keys[r]! < this.keys[l]! ? r : l;
      if (this.keys[c]! >= lastK) break;
      this.keys[i] = this.keys[c]!;
      this.vals[i] = this.vals[c]!;
      i = c;
    }
    this.keys[i] = lastK;
    this.vals[i] = lastV;
    return [key, val];
  }

  clear() {
    this.size = 0;
  }
}
