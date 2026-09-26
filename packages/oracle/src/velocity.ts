/**
 * Velocity: residents who keep hitting the chain's caps, or drain their aid unusually fast
 * compared with everyone else (robust z over the active population).
 */
import { clamp, median, robustStats, robustZ, type RobustStats } from "./stats";

export interface ResidentActivity {
  resident: number;
  aidCents: number;
  /** Sim time aid landed (null = not yet). */
  aidAt: number | null;
  /** Landed payments. */
  orders: number;
  /** Payments the chain turned away for a cap (OverDailyCap / OverOrderCap). */
  capHits: number;
  spentCents: number;
  /** Spent within the first 48 sim hours after aid landed. */
  spent48hCents: number;
  /** Sim time of the latest payment attempt. */
  lastAt: number | null;
}

export interface VelocityOptions {
  /** Cap rejections that alone open a case. */
  capHits: number;
  /** Share of aid spent within 48 h ... */
  fastShare: number;
  /** ... over at least this many orders. */
  fastOrders: number;
  /** ... with orders this many times the population's typical order (near-cap orders, not a big family's groceries). */
  bigOrder: number;
}

export const VELOCITY_DEFAULTS: VelocityOptions = { capHits: 2, fastShare: 0.8, fastOrders: 4, bigOrder: 1.5 };

export interface VelocityHit {
  resident: number;
  reason: "caps" | "speed";
  /** Share of aid spent in the first 48 h. */
  share48h: number;
  /** Its robust z against residents who have shopped. */
  z: number;
  score: number;
}

export function share48h(a: ResidentActivity): number {
  return a.aidCents > 0 ? a.spent48hCents / a.aidCents : 0;
}

export interface VelocityBaseline {
  /** 48 h spend share of residents with at least one order. */
  share: RobustStats;
  /** Their median order size, cents. */
  orderCents: number;
}

/** The population baseline over residents who have shopped. */
export function velocityBaseline(acts: ResidentActivity[]): VelocityBaseline {
  const xs: number[] = [];
  const orders: number[] = [];
  for (const a of acts) {
    if (a.orders <= 0 || a.aidCents <= 0) continue;
    xs.push(share48h(a));
    orders.push(a.spentCents / a.orders);
  }
  return { share: robustStats(xs), orderCents: median(orders) || 0 };
}

export function detectVelocity(acts: ResidentActivity[], opts: Partial<VelocityOptions> = {}, base = velocityBaseline(acts)): VelocityHit[] {
  const o = { ...VELOCITY_DEFAULTS, ...opts };
  const hits: VelocityHit[] = [];
  for (const a of acts) {
    const share = share48h(a);
    const z = robustZ(share, base.share, 0.02);
    const caps = a.capHits >= o.capHits;
    const avg = a.orders > 0 ? a.spentCents / a.orders : 0;
    const fast = a.orders >= o.fastOrders && share >= o.fastShare && avg >= o.bigOrder * base.orderCents;
    if (!caps && !fast) continue;
    const score = clamp(
      caps ? 0.62 + 0.08 * Math.min(4, a.capHits - o.capHits) + (fast ? 0.1 : 0) : 0.58 + 0.3 * clamp((share - o.fastShare * 0.6) / 0.5, 0, 1) + 0.02 * Math.min(5, a.orders - o.fastOrders),
      0,
      0.97,
    );
    hits.push({ resident: a.resident, reason: caps ? "caps" : "speed", share48h: share, z, score });
  }
  return hits;
}
