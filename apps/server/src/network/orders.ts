import { randomBytes } from "node:crypto";
import { DEFAULT_RULES, REJECTION_COPY } from "@rescu/chain";
import type { ConfirmResult, Order, OrderLine, OrderOrigin, PayerKind } from "@rescu/live";
import { ALL_ITEMS } from "../catalog.js";
import type { Run } from "../run.js";
import { countyLabel } from "../world.js";
import { ApiFail } from "./errors.js";
import { haversineKm, MarketError } from "./market.js";
import type { AppResident } from "./residents.js";

const KEEP = 2_000;

/**
 * Orders from the Shop tab, Grok, MCP clients and store counters. An order is proposed first
 * (priced, checked against stock, the order cap, the resident's 24 h window and balance), then
 * confirmed, which pays it on-chain. Store status is NOT checked here on purpose: paying a
 * suspended store goes to the chain, and the chain refuses it.
 */
export class Orders {
  private readonly byId = new Map<string, Order>();

  constructor(private readonly run: Run) {}

  get(id: string): Order | undefined {
    return this.byId.get(id);
  }

  forResident(idx: number, limit = 20): Order[] {
    const out: Order[] = [];
    for (const o of [...this.byId.values()].reverse()) {
      if (o.resident === idx) out.push(o);
      if (out.length >= limit) break;
    }
    return out;
  }

  forStore(m: number, limit = 50): Order[] {
    return [...this.byId.values()].filter((o) => o.store === m).slice(-limit).reverse();
  }

  /** Prices and checks an order. `r` is null for a counter charge (whoever scans the QR pays it). */
  async propose(r: AppResident | null, input: { store: number; lines: { itemId: number; qty: number }[]; note?: string | null; origin: OrderOrigin; payer?: PayerKind }): Promise<Order> {
    const run = this.run;
    if (run.phase !== "live") throw new ApiFail(409, "no_run", run.phase === "ended" ? "Aid has expired for this disaster" : "The relief network isn't live yet");
    const M = run.world.merchants;
    const m = input.store;
    if (!Number.isInteger(m) || m < 0 || m >= M.n) throw new ApiFail(404, "not_found", `No store ${m}`);
    const t = run.clock.now();
    if (!run.market.isOpen(m, t)) {
      const reopens = M.reopensAt[m]!;
      throw new ApiFail(409, "closed", `${M.name[m]} is closed after the storm${Number.isNaN(reopens) ? "" : ` (reopens in about ${Math.max(1, Math.round((reopens - t) / 3600))} h)`}`);
    }
    // Merge repeated items, then price them at this store now.
    const qty = new Map<number, number>();
    for (const l of input.lines) qty.set(l.itemId, (qty.get(l.itemId) ?? 0) + l.qty);
    // An agent's basket is fitted to the shelf as it is now: other shoppers keep buying while
    // Grok thinks, so a line that sold out is dropped and a short one is cut, with a note.
    const fitted = input.origin === "agent" || input.origin === "mcp" ? this.fitToShelf(m, qty, t) : null;
    let lines: OrderLine[];
    try {
      lines = run.market.priceLines(m, [...qty].map(([itemId, q]) => ({ itemId, qty: q })), t);
    } catch (err) {
      if (err instanceof MarketError) throw new ApiFail(409, err.code, err.message);
      throw err;
    }
    const total = lines.reduce((a, l) => a + l.qty * l.unitCents, 0);
    const cap = DEFAULT_RULES.perOrderCapUsd * 100;
    if (total > cap) throw new ApiFail(409, "over_order_cap", `That's $${(total / 100).toFixed(2)}; one order can be at most $${cap / 100}. Split it or drop something.`);
    if (r) this.checkWallet(r, total, t);
    const o: Order = {
      id: `o_${randomBytes(6).toString("base64url")}`,
      runId: run.key,
      resident: r?.idx ?? null,
      residentName: r?.name ?? null,
      store: m,
      storeName: M.name[m]!,
      category: M.category[m]!,
      lines,
      totalCents: total,
      origin: input.origin,
      payer: input.payer ?? (input.origin === "agent" || input.origin === "mcp" ? "agent" : "resident"),
      status: "proposed",
      createdAt: Date.now(),
      simT: t,
      pickup: { name: M.name[m]!, county: countyLabel(run.world, M.county[m]!), lat: M.lat[m]!, lon: M.lon[m]!, distanceKm: r ? round1(haversineKm(r.lat, r.lon, M.lat[m]!, M.lon[m]!)) : null },
      home: r ? [r.lon, r.lat] : null,
      note: input.note ?? null,
      signature: null,
      rule: null,
      message: run.market.status[m] === "approved" ? (fitted?.note ?? null) : `${M.name[m]} is ${run.market.status[m]}; the chain will refuse this payment.`,
      latencyMs: null,
      paidAt: null,
    };
    this.store(o);
    return o;
  }

  /** Cuts each line to the store's stock (and the item's max); drops what sold out. Mutates `qty`. */
  private fitToShelf(m: number, qty: Map<number, number>, t: number): { note: string | null } {
    const market = this.run.market;
    const gone: string[] = [];
    const cut: string[] = [];
    for (const [itemId, want] of [...qty]) {
      const item = ALL_ITEMS[itemId];
      if (!item || !market.carries(m, itemId)) continue; // priceLines explains it
      const have = Math.min(market.stock(m, itemId, t), item.maxQty);
      if (have <= 0) {
        qty.delete(itemId);
        gone.push(item.name.split(",")[0]!);
      } else if (have < want) {
        qty.set(itemId, have);
        cut.push(`${have} of ${want} ${item.name.split(",")[0]!.toLowerCase()}`);
      }
    }
    if (!qty.size) throw new ApiFail(409, "out_of_stock", `Everything in that basket just sold out at ${this.run.world.merchants.name[m]}. Search again for another store.`);
    const parts = [gone.length ? `Sold out: ${gone.join(", ")}` : null, cut.length ? `only ${cut.join(", ")} left` : null].filter(Boolean);
    return { note: parts.length ? `${parts.join("; ")}.` : null };
  }

  /** Window and balance checks, so Grok's baskets fit before they reach the chain. */
  private checkWallet(r: AppResident, total: number, t: number) {
    const people = this.run.people;
    const cap = DEFAULT_RULES.dailyCapUsd * 100;
    const used = people.windowSpent(r, t);
    if (used + total > cap) {
      throw new ApiFail(409, "over_daily_cap", `Only $${((cap - used) / 100).toFixed(2)} left in this 24-hour window ($${cap / 100} per 24 h).`);
    }
    const balance = r.aidCents - people.spent(r);
    if (Number.isNaN(people.fundedAt(r))) throw new ApiFail(409, "no_aid_yet", "Aid hasn't landed in this wallet yet");
    if (total > balance) throw new ApiFail(409, "insufficient_funds", `Balance is $${(balance / 100).toFixed(2)}`);
  }

  /** Pays a proposed order (resident key, or the agent's allowance). Device custody paying as the resident returns a SignRequest. */
  async confirm(id: string, r: AppResident, payer?: PayerKind): Promise<ConfirmResult> {
    const run = this.run;
    const o = this.byId.get(id);
    if (!o) throw new ApiFail(404, "not_found", "No such order");
    if (o.status !== "proposed") throw new ApiFail(409, "not_proposed", `This order is already ${o.status}`);
    if (o.resident === null) {
      // A counter charge: whoever scans it pays it.
      o.resident = r.idx;
      o.residentName = r.name;
      o.home = [r.lon, r.lat];
      o.pickup.distanceKm = round1(haversineKm(r.lat, r.lon, o.pickup.lat, o.pickup.lon));
    } else if (o.resident !== r.idx) throw new ApiFail(403, "forbidden", "That order belongs to someone else");
    if (run.phase !== "live") throw new ApiFail(409, "no_run", "The relief network isn't live");
    o.payer = payer ?? o.payer;
    o.status = "paying";
    o.simT = run.clock.now();

    if (o.payer === "resident" && r.custody === "device") {
      const prepared = await run.chain.preparePay({ mint: run.mint, owner: r.owner, merchant: run.merchantKeys[o.store]!.publicKey, cents: o.totalCents });
      const sign = run.people.relayRequest(r, "pay", prepared, o.id, async (sig) => {
        const res = await run.chain.submitPrepared(prepared, { [r.owner.toBase58()]: sig });
        const out = run.settleApp({ resident: r, store: o.store, lines: o.lines, cents: o.totalCents, payer: "resident", origin: o.origin, orderId: o.id }, res);
        this.finish(o, out);
        return { ok: out.ok, signature: out.signature, rule: out.rule, message: out.message, order: o, wallet: await run.people.wallet(r) };
      });
      return { order: o, sign };
    }

    const out = await run.payApp({ resident: r, store: o.store, lines: o.lines, cents: o.totalCents, payer: o.payer, origin: o.origin, orderId: o.id });
    this.finish(o, out);
    return { order: o, sign: null };
  }

  cancel(id: string, r: AppResident): Order {
    const o = this.byId.get(id);
    if (!o) throw new ApiFail(404, "not_found", "No such order");
    if (o.resident !== null && o.resident !== r.idx) throw new ApiFail(403, "forbidden", "That order belongs to someone else");
    if (o.status !== "proposed") throw new ApiFail(409, "not_proposed", `This order is already ${o.status}`);
    o.status = "cancelled";
    return o;
  }

  private finish(o: Order, out: { ok: boolean; signature: string | null; rule: string | null; message: string | null; latencyMs: number }) {
    o.status = out.ok ? "paid" : "rejected";
    o.signature = out.signature;
    o.rule = out.rule;
    o.message = out.ok ? null : (out.message ?? (out.rule ? (REJECTION_COPY[out.rule] ?? out.rule) : "Payment failed"));
    o.latencyMs = out.latencyMs;
    o.paidAt = out.ok ? Date.now() : null;
    o.simT = this.run.clock.now();
  }

  private store(o: Order) {
    this.byId.set(o.id, o);
    if (this.byId.size > KEEP) this.byId.delete(this.byId.keys().next().value!);
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;
