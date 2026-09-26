import { GENERATOR, type Item, NEEDS, type Need, needWeights, SELLS_NEED, shelfCents, STOCK } from "./catalog.js";
import type { MerchantCategory } from "@rescu/live";
import type { Rng } from "./rng.js";
import { CATEGORIES, isOpen, NEAR_K, ROGUE, type World } from "./world.js";

const HOUR = 3600;
const DAY = 86400;
/** Unregistered stores rule-breakers try to pay (their token accounts exist, their merchant records don't). */
export const ROGUE_STORES = 5;

const total = (lines: OrderLine[]) => lines.reduce((x, l) => x + l.qty * l.cents, 0);

/**
 * Legit shoppers stay well inside the chain's caps ($200 per order, $300 per rolling 24 h).
 * The chain's clock only moves in whole seconds (4.8 sim hours at 12x), so the sim plans against
 * a wider 32 h window and a $280 ceiling; that margin keeps honest orders from ever tripping a cap.
 */
export const PLAN = {
  orderCapCents: 19_500,
  windowSecs: 32 * HOUR,
  windowCapCents: 28_000,
  /** Recent orders remembered per household for the window check. */
  ring: 6,
  minOrderCents: 1_200,
} as const;

export interface OrderLine {
  id: number;
  qty: number;
  cents: number;
}

export interface Order {
  household: number;
  /** Merchant index, or -1 when the destination isn't a registered store (rule-breakers). */
  merchant: number;
  lines: OrderLine[];
  amountCents: number;
  need: Need;
  rogue: number;
  /** Rule-breakers only: pay this resident's wallet instead of a store. */
  resaleTo?: number;
  /** Rule-breakers only: pay this unregistered store (index into the run's rogue stores). */
  rogueStore?: number;
}

/** Per-household spending state, in typed arrays (20,000 households). */
export class Households {
  readonly fundedAt: Float64Array;
  readonly spent: Int32Array;
  readonly reserved: Int32Array;
  readonly target: Int32Array;
  readonly nextTrip: Float64Array;
  readonly done: Uint8Array;
  readonly rogueDone: Uint8Array;
  private readonly ringT: Float64Array;
  private readonly ringC: Int32Array;
  private readonly ringAt: Uint8Array;

  constructor(readonly n: number) {
    this.fundedAt = new Float64Array(n).fill(Number.NaN);
    this.spent = new Int32Array(n);
    this.reserved = new Int32Array(n);
    this.target = new Int32Array(n);
    this.nextTrip = new Float64Array(n).fill(Infinity);
    this.done = new Uint8Array(n);
    this.rogueDone = new Uint8Array(n);
    this.ringT = new Float64Array(n * PLAN.ring).fill(-Infinity);
    this.ringC = new Int32Array(n * PLAN.ring);
    this.ringAt = new Uint8Array(n);
  }

  /** Spent (or in flight) inside the planning window ending at t, and when the oldest of it ages out. */
  window(h: number, t: number): { cents: number; freesAt: number } {
    let cents = 0;
    let oldest = Infinity;
    for (let k = 0; k < PLAN.ring; k++) {
      const at = this.ringT[h * PLAN.ring + k]!;
      if (at > t - PLAN.windowSecs) {
        cents += this.ringC[h * PLAN.ring + k]!;
        oldest = Math.min(oldest, at);
      }
    }
    return { cents, freesAt: oldest + PLAN.windowSecs };
  }

  record(h: number, t: number, cents: number) {
    const k = this.ringAt[h]!;
    this.ringT[h * PLAN.ring + k] = t;
    this.ringC[h * PLAN.ring + k] = cents;
    this.ringAt[h] = (k + 1) % PLAN.ring;
  }

  /** Landed or in-flight spending recorded after sim time `since` (the ring holds the last few orders). */
  spentSince(h: number, since: number): number {
    let cents = 0;
    for (let k = 0; k < PLAN.ring; k++) {
      if (this.ringT[h * PLAN.ring + k]! > since) cents += this.ringC[h * PLAN.ring + k]!;
    }
    return cents;
  }

  /** A rejected order didn't count toward the window after all. */
  forget(h: number, t: number, cents: number) {
    for (let k = 0; k < PLAN.ring; k++) {
      const o = h * PLAN.ring + k;
      if (this.ringT[o] === t && this.ringC[o] === cents) {
        this.ringT[o] = -Infinity;
        return;
      }
    }
  }
}

export type Trip = { kind: "orders"; orders: Order[]; next: number } | { kind: "later"; next: number } | { kind: "stop" };

/**
 * Rule-based shoppers: water, food and power first, then cleanup and repairs, then ordinary
 * groceries, each trip at the nearest open store that sells what they need.
 */
export class Shopper {
  constructor(
    readonly world: World,
    readonly rng: Rng,
  ) {}

  /** Called once when a household's aid confirms. */
  funded(s: Households, h: number, t: number) {
    const aid = this.world.households.aidCents[h]!;
    s.fundedAt[h] = t;
    s.target[h] = Math.round(aid * this.rng.range(0.72, 0.98));
    s.nextTrip[h] = t + this.rng.range(2, 20) * HOUR;
    const rogue = this.world.households.rogue[h]!;
    // Rule-breaking only makes sense with enough balance to get past Token-2022's own balance check.
    if (rogue === ROGUE.generator && aid < 52_000) this.world.households.rogue[h] = ROGUE.none;
    if (rogue === ROGUE.spree && aid < 46_000) this.world.households.rogue[h] = ROGUE.none;
  }

  trip(s: Households, h: number, t: number): Trip {
    const W = this.world;
    if (t > W.domain.end - 12 * HOUR) return { kind: "stop" };
    const days = (t - s.fundedAt[h]!) / DAY;
    const balance = W.households.aidCents[h]! - s.spent[h]! - s.reserved[h]!;

    const rogue = W.households.rogue[h]!;
    if (rogue && !s.rogueDone[h] && days >= 1) {
      s.rogueDone[h] = 1;
      const orders = rogue === ROGUE.spree ? this.spree(s, h, t, days) : this.rogueOrder(h, t, rogue, balance);
      if (orders) return { kind: "orders", orders, next: t + this.gap(days) };
    }

    const left = Math.min(s.target[h]! - s.spent[h]! - s.reserved[h]!, balance);
    if (left < PLAN.minOrderCents) return { kind: "stop" };
    const win = s.window(h, t);
    const headroom = PLAN.windowCapCents - win.cents;
    if (headroom < 1_500) return { kind: "later", next: win.freesAt + HOUR };

    const [lo, hi] = days < 3 ? [9_000, 19_000] : days < 10 ? [6_000, 16_000] : [3_500, 14_000];
    const budget = Math.min(Math.round(this.rng.range(lo, hi)), left, headroom, PLAN.orderCapCents);

    const weights = needWeights(days, !!W.households.kids[h], !!W.households.pet[h]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const need = NEEDS[this.rng.weighted(weights)]!;
      const m = this.nearestOpen(h, need, t);
      if (m < 0) {
        weights[NEEDS.indexOf(need)] = 0;
        continue;
      }
      const lines = this.basket(m, need, budget, weights);
      const amountCents = total(lines);
      if (!lines.length || amountCents < 300) continue;
      return { kind: "orders", orders: [{ household: h, merchant: m, lines, amountCents, need, rogue: 0 }], next: t + this.gap(days) };
    }
    return { kind: "later", next: t + this.rng.range(6, 12) * HOUR };
  }

  private gap(days: number): number {
    if (days < 3) return this.rng.range(14, 32) * HOUR;
    if (days < 10) return this.rng.range(1.5, 4) * DAY;
    return this.rng.range(3, 7) * DAY;
  }

  /** Closest open store (among each category's nearest few) that sells something for `need`. */
  nearestOpen(h: number, need: Need, t: number): number {
    return this.nearestOpenIn(h, SELLS_NEED[need], t);
  }

  nearestOpenIn(h: number, categories: readonly MerchantCategory[], t: number): number {
    const W = this.world;
    const H = W.households;
    const k = Math.cos((H.lat[h]! * Math.PI) / 180);
    let best = -1;
    let bestD = Infinity;
    for (const cat of categories) {
      const c = CATEGORIES.indexOf(cat);
      for (let j = 0; j < NEAR_K; j++) {
        const m = H.near[(h * CATEGORIES.length + c) * NEAR_K + j]!;
        if (m < 0 || !isOpen(W, m, t)) continue;
        const dx = (W.merchants.lon[m]! - H.lon[h]!) * k;
        const dy = W.merchants.lat[m]! - H.lat[h]!;
        const d = dx * dx + dy * dy;
        if (d < bestD) [best, bestD] = [m, d];
      }
    }
    return best;
  }

  /** Items from the store's shelf: the main need first, then whatever else the household needs. */
  basket(m: number, need: Need, budget: number, weights: number[]): OrderLine[] {
    const shelf = STOCK[this.world.merchants.category[m]!];
    const primary = shelf.filter((i) => i.need === need);
    const others = shelf.filter((i) => i.need !== need && weights[NEEDS.indexOf(i.need)]! > 0);
    const order: Item[] = [...this.shuffle(primary).slice(0, 3), ...this.shuffle(others)];
    const lines: OrderLine[] = [];
    let total = 0;
    for (const item of order) {
      const cents = shelfCents(m, item);
      const room = Math.floor((budget - total) / cents);
      if (room < 1) continue;
      const qty = Math.min(room, this.rng.int(1, item.maxQty));
      lines.push({ id: item.id, qty, cents });
      total += qty * cents;
      if (total >= budget * 0.75 || lines.length >= 6) break;
    }
    return lines;
  }

  private rogueOrder(h: number, t: number, rogue: number, balance: number): Order[] | null {
    const W = this.world;
    if (rogue === ROGUE.generator) {
      const m = this.nearestOpenIn(h, ["hardware"], t);
      if (m < 0 || balance < GENERATOR.cents) return null;
      return [{ household: h, merchant: m, lines: [{ id: GENERATOR.id, qty: 1, cents: GENERATOR.cents }], amountCents: GENERATOR.cents, need: "power", rogue }];
    }
    // Moving aid to someone who isn't a relief store: no goods change hands, so no lines.
    const amountCents = Math.min(balance, Math.round(this.rng.range(4_000, 12_000)));
    if (amountCents < 1_000) return null;
    if (rogue === ROGUE.resale) {
      return [{ household: h, merchant: -1, lines: [], amountCents, need: "food", rogue, resaleTo: (h + 1) % W.households.n }];
    }
    if (rogue === ROGUE.unregistered) {
      return [{ household: h, merchant: -1, lines: [], amountCents, need: "food", rogue, rogueStore: this.rng.int(0, ROGUE_STORES - 1) }];
    }
    return null;
  }

  /**
   * A buying spree at one store: the first two orders fit under $300 together, the third
   * (at least $90) can't, so the chain's rolling 24 h cap turns it away.
   */
  private spree(s: Households, h: number, t: number, days: number): Order[] | null {
    const m = this.nearestOpen(h, "food", t);
    const balance = this.world.households.aidCents[h]! - s.spent[h]! - s.reserved[h]!;
    if (m < 0 || balance < 46_000 || s.window(h, t).cents > 0) return null;
    const weights = needWeights(days, !!this.world.households.kids[h], !!this.world.households.pet[h]);
    const first = this.basket(m, "food", 15_000, weights);
    const a1 = total(first);
    const second = this.basket(m, "water", 30_000 - a1, weights);
    const third = this.basket(m, "food", 12_000, weights);
    const sum = a1 + total(second);
    if (!first.length || !second.length || sum > 30_000 || sum + total(third) < 31_000) return null;
    return [first, second, third].map((lines) => ({ household: h, merchant: m, lines, amountCents: total(lines), need: "food" as Need, rogue: ROGUE.spree }));
  }

  private shuffle<T>(xs: T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}
