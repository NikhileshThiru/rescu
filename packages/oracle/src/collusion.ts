/**
 * Collusion (aid-for-cash): a store where several residents spend nearly all of their relief
 * money, AND whose takings are abnormal for a store of its type nearby (robust z of log volume).
 */
import type { Neighbor } from "./gouging";
import { clamp, median, robustStats, robustZ } from "./stats";

export interface StoreVolume {
  store: number;
  category: string;
  volumeCents: number;
}

export interface ResidentTopStore {
  resident: number;
  aidCents: number;
  spentCents: number;
  orders: number;
  /** Where most of their money went. */
  store: number;
  centsAtStore: number;
}

export interface CollusionOptions {
  /** Share of a resident's spending at the one store. */
  share: number;
  /** A resident counts once they've spent this share of their aid (one small purchase is 100% "at one store"). */
  minSpentShare: number;
  minOrders: number;
  /** Residents needed at one store. */
  minResidents: number;
  /** Their average order vs the population's typical order (aid-for-cash runs near the cap). */
  bigOrder: number;
  /** The store must also stand out: robust z of its log volume vs same-category stores nearby ... */
  zVolume: number;
  /** ... or this share of its takings coming from those residents. */
  concentration: number;
}

export const COLLUSION_DEFAULTS: CollusionOptions = { share: 0.9, minSpentShare: 0.4, minOrders: 3, minResidents: 3, bigOrder: 1.5, zVolume: 1.5, concentration: 0.15 };

export interface CollusionHit {
  store: number;
  residents: { resident: number; spentCents: number; centsAtStore: number; share: number }[];
  volumeCents: number;
  expectedCents: number;
  z: number;
  /** Share of the store's volume that came from those residents. */
  concentration: number;
  score: number;
}

/** Log-volume baseline of same-category stores near `store` (all of the category when too few are near). */
export function volumeBaseline(store: number, stores: StoreVolume[], neighbors: Neighbor[][], minPeers = 5) {
  const cat = stores[store]!.category;
  let peers = neighbors[store]!.map((n) => stores[n.store]!).filter((s) => s.category === cat);
  if (peers.length < minPeers) peers = stores.filter((s) => s.category === cat && s.store !== store);
  const vols = peers.map((p) => p.volumeCents);
  const logs = vols.map((v) => Math.log1p(v / 100));
  return { expectedCents: median(vols) || 0, stats: robustStats(logs) };
}

export function detectCollusion(stores: StoreVolume[], residents: ResidentTopStore[], neighbors: Neighbor[][], opts: Partial<CollusionOptions> = {}): CollusionHit[] {
  const o = { ...COLLUSION_DEFAULTS, ...opts };
  const typical = median(residents.filter((r) => r.orders > 0).map((r) => r.spentCents / r.orders)) || 0;
  const byStore = new Map<number, CollusionHit["residents"]>();
  for (const r of residents) {
    if (r.orders < o.minOrders || r.spentCents <= 0 || r.aidCents <= 0) continue;
    if (r.spentCents / r.aidCents < o.minSpentShare) continue;
    if (r.spentCents / r.orders < o.bigOrder * typical) continue;
    const share = r.centsAtStore / r.spentCents;
    if (share < o.share) continue;
    const list = byStore.get(r.store) ?? [];
    list.push({ resident: r.resident, spentCents: r.spentCents, centsAtStore: r.centsAtStore, share });
    byStore.set(r.store, list);
  }
  const hits: CollusionHit[] = [];
  for (const [store, list] of byStore) {
    if (list.length < o.minResidents || !stores[store]) continue;
    const vol = stores[store]!.volumeCents;
    const { expectedCents, stats } = volumeBaseline(store, stores, neighbors);
    const z = robustZ(Math.log1p(vol / 100), stats, 0.05);
    const fromThem = list.reduce((a, r) => a + r.centsAtStore, 0);
    const concentration = vol > 0 ? clamp(fromThem / vol, 0, 1) : 0;
    if (z < o.zVolume && concentration < o.concentration) continue;
    list.sort((a, b) => b.centsAtStore - a.centsAtStore);
    const score = clamp(0.6 + 0.04 * Math.min(6, list.length - o.minResidents) + 0.04 * clamp(z, 0, 5) + 0.3 * concentration, 0, 0.97);
    hits.push({ store, residents: list, volumeCents: vol, expectedCents, z, concentration, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}
