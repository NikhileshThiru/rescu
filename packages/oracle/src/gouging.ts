/**
 * Gouging: every listed price against that item's PRE-STORM regional median (the median of the
 * pre-storm shelf prices at stores carrying it within ~50 km; all stores when too few are near).
 * Pre-storm prices never change during a run, so the medians are computed once.
 */
import { clamp, haversineKm, median } from "./stats";

export interface StoreGeo {
  lat: number;
  lon: number;
}

export interface ShelfItem {
  itemId: number;
  preStormCents: number;
  priceCents: number;
}

export interface Neighbor {
  store: number;
  km: number;
}

/** Other stores within `radiusKm` of each store, nearest first. */
export function neighborIndex(stores: StoreGeo[], radiusKm = 50): Neighbor[][] {
  const out: Neighbor[][] = stores.map(() => []);
  for (let a = 0; a < stores.length; a++) {
    const A = stores[a]!;
    for (let b = a + 1; b < stores.length; b++) {
      const B = stores[b]!;
      // Cheap reject before the trig.
      if (Math.abs(A.lat - B.lat) > radiusKm / 100) continue;
      const km = haversineKm(A.lat, A.lon, B.lat, B.lon);
      if (km > radiusKm) continue;
      out[a]!.push({ store: b, km });
      out[b]!.push({ store: a, km });
    }
  }
  for (const list of out) list.sort((x, y) => x.km - y.km);
  return out;
}

/**
 * Pre-storm regional median per store and item: the store itself plus neighbours carrying the
 * item; when fewer than `minPeers` carry it nearby, every store that carries it.
 */
export function regionalMedians(shelves: ShelfItem[][], neighbors: Neighbor[][], minPeers = 4): Map<number, number>[] {
  const pre = shelves.map((items) => new Map(items.map((i) => [i.itemId, i.preStormCents])));
  const global = new Map<number, number>();
  const all = new Map<number, number[]>();
  for (const s of pre) for (const [id, c] of s) (all.get(id) ?? all.set(id, []).get(id)!).push(c);
  for (const [id, cs] of all) global.set(id, median(cs));
  return pre.map((mine, s) => {
    const out = new Map<number, number>();
    for (const [id, c] of mine) {
      const prices = [c];
      for (const n of neighbors[s]!) {
        const v = pre[n.store]!.get(id);
        if (v !== undefined) prices.push(v);
      }
      out.set(id, prices.length >= minPeers ? median(prices) : global.get(id)!);
    }
    return out;
  });
}

export interface GougedItem {
  itemId: number;
  priceCents: number;
  medianCents: number;
  /** priceCents / medianCents. */
  ratio: number;
}

export interface GougeHit {
  store: number;
  /** Items over the threshold, worst first. */
  items: GougedItem[];
}

/** Stores that raised at least one item to more than `thresholdPct` over its pre-storm regional median. */
export function detectGouging(shelves: ShelfItem[][], medians: Map<number, number>[], thresholdPct = 25): GougeHit[] {
  const limit = 1 + thresholdPct / 100;
  const hits: GougeHit[] = [];
  shelves.forEach((items, store) => {
    const med = medians[store];
    if (!med) return;
    const over: GougedItem[] = [];
    for (const i of items) {
      const m = med.get(i.itemId);
      // Only a price that went UP counts (a store that was always dear isn't gouging).
      if (!m || m <= 0 || i.priceCents <= i.preStormCents) continue;
      const ratio = i.priceCents / m;
      if (ratio > limit) over.push({ itemId: i.itemId, priceCents: i.priceCents, medianCents: Math.round(m), ratio });
    }
    if (over.length) {
      over.sort((a, b) => b.ratio - a.ratio);
      hits.push({ store, items: over });
    }
  });
  return hits;
}

/** Rule score for a markup: just over the threshold ~0.55, 2x ~0.8, 3x and up ~0.95. */
export function gougeScore(ratio: number, thresholdPct = 25, gougedItems = 1): number {
  const over = Math.max(0, ratio - (1 + thresholdPct / 100));
  const s = 0.55 + 0.4 * (1 - Math.exp(-over / 0.9)) + 0.02 * Math.min(5, gougedItems - 1);
  return clamp(s, 0, 0.99);
}
