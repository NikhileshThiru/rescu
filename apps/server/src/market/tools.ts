import {
  ConfirmOrderInput,
  type ConfirmResult,
  GetStoreInput,
  ListOrdersInput,
  ListStoresInput,
  type MarketToolName,
  type Offer,
  type Order,
  type OrderOrigin,
  ProposeOrderInput,
  SearchItemsInput,
  type StoreDetail,
  type StoreSummary,
  type WalletView,
} from "@rescu/live";
import { ApiFail } from "../network/errors.js";
import type { AppResident } from "../network/residents.js";
import type { Run } from "../run.js";

/** Stores farther than this from the search point aren't a realistic pickup after a hurricane. */
export const MAX_STORE_KM = 150;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The run's local time zone (the map uses the same rule). */
export function runTimeZone(run: Run): string {
  return run.world.domain.landfallLon < -85.5 ? "America/Chicago" : "America/New_York";
}

export function simDate(run: Run, t = run.clock.now()): string {
  return new Date(t * 1000).toLocaleString("en-US", { timeZone: runTimeZone(run), weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ---------- the handlers (REST, MCP and Grok all call these) ----------

export function searchItems(run: Run, r: AppResident, input: SearchItemsInput): Offer[] {
  const near = input.near ?? { lat: r.lat, lon: r.lon };
  return run.market.search({ ...input, near }, run.clock.now(), near).filter((o) => (o.store.distanceKm ?? 0) <= MAX_STORE_KM);
}

export function listStores(run: Run, r: AppResident, input: ListStoresInput): StoreSummary[] {
  const near = input.near ?? { lat: r.lat, lon: r.lon };
  return run.market.stores({ ...input, near }, run.clock.now(), near).filter((s) => (s.distanceKm ?? 0) <= MAX_STORE_KM);
}

export function getStore(run: Run, idx: number, near?: { lat: number; lon: number }): StoreDetail {
  if (!Number.isInteger(idx) || idx < 0 || idx >= run.market.n) throw new ApiFail(404, "not_found", `No store ${idx}`);
  return run.market.detail(idx, run.clock.now(), near);
}

export function proposeOrder(run: Run, r: AppResident, input: ProposeOrderInput, origin: OrderOrigin): Promise<Order> {
  return run.orders.propose(r, { store: input.store, lines: input.lines, note: input.note ?? null, origin });
}

export function confirmOrder(run: Run, r: AppResident, input: ConfirmOrderInput): Promise<ConfirmResult> {
  return run.orders.confirm(input.orderId, r, input.payer);
}

// ---------- compact views: what a model needs, nothing more (tokens cost money) ----------

export function compactWallet(run: Run, w: WalletView) {
  return {
    name: w.name,
    home: w.home.county,
    household: w.household,
    today: simDate(run, w.simNow),
    aidLanded: w.aid.landed,
    balance: dollars(w.balanceCents),
    left24h: dollars(w.window.remainingCents),
    perOrderCap: dollars(w.window.perOrderCapCents),
    agentAllowance: w.agent.approved ? dollars(w.agent.allowanceCents) : "none (resident must grant it)",
    frozen: w.frozen,
  };
}

/** Offers grouped by store, nearest first: [itemId, name, price, stock, maxQty]. */
export function compactOffers(offers: Offer[]) {
  const stores = new Map<number, { store: number; name: string; type: string; km: number | null; items: [number, string, string, number, number][] }>();
  for (const o of offers) {
    let s = stores.get(o.store.idx);
    if (!s) {
      s = { store: o.store.idx, name: o.store.name, type: o.store.category, km: o.store.distanceKm, items: [] };
      stores.set(o.store.idx, s);
    }
    s.items.push([o.item.itemId, o.item.name, dollars(o.item.priceCents), o.item.stock, o.item.maxQty]);
  }
  return { columns: ["itemId", "name", "price", "stock", "maxQty"], stores: [...stores.values()] };
}

export function compactStores(stores: StoreSummary[]) {
  return stores.map((s) => ({ store: s.idx, name: s.name, type: s.category, km: s.distanceKm, open: s.open }));
}

export function compactStore(d: StoreDetail) {
  return {
    store: d.idx,
    name: d.name,
    type: d.category,
    km: d.distanceKm,
    open: d.open,
    status: d.status,
    columns: ["itemId", "name", "price", "stock", "maxQty"],
    items: d.listings.filter((l) => l.stock > 0).map((l) => [l.itemId, l.name, dollars(l.priceCents), l.stock, l.maxQty]),
  };
}

export function compactOrder(o: Order) {
  return {
    orderId: o.id,
    status: o.status,
    store: o.store,
    storeName: o.storeName,
    km: o.pickup.distanceKm,
    lines: o.lines.map((l) => `${l.qty} x ${l.name} @ ${dollars(l.unitCents)}`),
    total: dollars(o.totalCents),
    ...(o.signature ? { signature: o.signature } : {}),
    ...(o.rule ? { rule: o.rule, message: o.message } : {}),
    ...(o.status === "proposed" && o.message ? { warning: o.message } : {}),
  };
}

/** One Relief Market tool call for an agent (Grok or MCP): validated input in, compact JSON out. */
export async function runTool(
  run: Run,
  r: AppResident,
  name: MarketToolName,
  raw: unknown,
  origin: "agent" | "mcp",
): Promise<{ result: unknown; summary: string; order?: Order }> {
  switch (name) {
    case "get_wallet": {
      const w = await run.people.wallet(r);
      return { result: compactWallet(run, w), summary: `Wallet: ${dollars(w.balanceCents)} balance, ${dollars(w.window.remainingCents)} left today` };
    }
    case "search_items": {
      const input = SearchItemsInput.parse(raw ?? {});
      const offers = searchItems(run, r, input);
      const what = input.query ?? input.need ?? input.category ?? "everything";
      const stores = new Set(offers.map((o) => o.store.idx)).size;
      return { result: compactOffers(offers), summary: offers.length ? `Searched "${what}": ${offers.length} ${offers.length === 1 ? "offer" : "offers"} at ${stores} ${stores === 1 ? "store" : "stores"}` : `Searched "${what}": nothing in stock nearby` };
    }
    case "list_stores": {
      const input = ListStoresInput.parse(raw ?? {});
      const stores = listStores(run, r, input);
      return { result: compactStores(stores), summary: `Found ${stores.length} open ${stores.length === 1 ? "store" : "stores"} nearby` };
    }
    case "get_store": {
      const input = GetStoreInput.parse(raw ?? {});
      const d = getStore(run, input.store, { lat: r.lat, lon: r.lon });
      return { result: compactStore(d), summary: `Checked ${d.name}'s shelf` };
    }
    case "propose_order": {
      const input = ProposeOrderInput.parse(raw ?? {});
      const o = await proposeOrder(run, r, input, origin);
      return { result: compactOrder(o), summary: `Proposed ${dollars(o.totalCents)} at ${o.storeName}`, order: o };
    }
    case "confirm_order": {
      const input = ConfirmOrderInput.parse(raw ?? {});
      const res = await confirmOrder(run, r, { orderId: input.orderId, payer: input.payer ?? "agent" });
      if (res.sign) {
        return { result: { ...compactOrder(res.order), next: "This wallet's key is on the resident's phone: they must approve it in the app." }, summary: "Waiting for the resident's phone", order: res.order };
      }
      const o = res.order;
      return { result: compactOrder(o), summary: o.status === "paid" ? `Paid ${dollars(o.totalCents)} at ${o.storeName}` : `Blocked: ${o.rule ?? o.message}`, order: o };
    }
    case "list_orders": {
      const input = ListOrdersInput.parse(raw ?? {});
      const orders = run.orders.forResident(r.idx, input.limit ?? 10);
      return { result: orders.map(compactOrder), summary: `Looked up ${orders.length} recent ${orders.length === 1 ? "order" : "orders"}` };
    }
  }
}

/** Errors a tool call returns to the model as data (so it can adjust), not as an exception. */
export function toolError(err: unknown): { error: string; code: string | null } {
  if (err instanceof ApiFail) return { error: err.message, code: err.code };
  const e = err as { issues?: { path: PropertyKey[]; message: string }[]; message?: string };
  if (Array.isArray(e.issues)) return { error: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), code: "bad_request" };
  return { error: e.message ?? "Tool failed", code: null };
}
