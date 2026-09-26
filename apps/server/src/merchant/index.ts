import { type ApiRoutes, CATEGORIES, ChargeInput, type MerchantCategory, SetPriceInput } from "@rescu/live";
import type { FastifyInstance } from "fastify";
import type { Run } from "../run.js";
import { ApiFail, currentRun, requirePresenter, type Services } from "../services.js";

type Res<R extends keyof ApiRoutes> = Promise<ApiRoutes[R]["res"]>;

function storeIdx(run: Run, raw: string): number {
  const m = Number(raw);
  if (!Number.isInteger(m) || m < 0 || m >= run.world.merchants.n) throw new ApiFail(404, "not_found", `No store ${raw}`);
  return m;
}

/** Merchant terminal routes (`/api/merchant/*`): any store's shelf, prices, activity and counter charges. */
export async function registerMerchant(app: FastifyInstance, s: Services): Promise<void> {
  /** Every store for the picker, suspended and closed ones included, by name. */
  app.get<{ Querystring: { q?: string; category?: string } }>("/api/merchant/stores", async (req): Res<"GET /api/merchant/stores"> => {
    const run = currentRun(s);
    const q = req.query.q?.trim().slice(0, 80) || undefined;
    const cat = req.query.category;
    const category = cat && (CATEGORIES as readonly string[]).includes(cat) ? (cat as MerchantCategory) : undefined;
    return run.market.stores({ query: q, category, openOnly: false, includeAll: true, limit: run.world.merchants.n }, run.clock.now());
  });

  app.get<{ Params: { idx: string } }>("/api/merchant/stores/:idx", async (req): Res<"GET /api/merchant/stores/:idx"> => {
    const run = currentRun(s);
    return run.market.detail(storeIdx(run, req.params.idx), run.clock.now());
  });

  /** Sets a listed price; the oracle hears about it at once (a gouging case opens within ~1-2 s). */
  app.patch<{ Params: { idx: string } }>("/api/merchant/stores/:idx/prices", async (req): Res<"PATCH /api/merchant/stores/:idx/prices"> => {
    requirePresenter(req);
    const run = currentRun(s);
    const m = storeIdx(run, req.params.idx);
    const body = SetPriceInput.parse(req.body ?? {});
    return run.setPrice(m, body.itemId, body.priceCents);
  });

  app.get<{ Params: { idx: string }; Querystring: { since?: string } }>("/api/merchant/stores/:idx/activity", async (req): Res<"GET /api/merchant/stores/:idx/activity"> => {
    const run = currentRun(s);
    const m = storeIdx(run, req.params.idx);
    const since = Number(req.query.since ?? 0);
    return run.activity.page(m, Number.isFinite(since) && since > 0 ? since : 0);
  });

  /** Rings up a counter sale: a proposed order with no resident yet; whoever scans the QR pays it. */
  app.post<{ Params: { idx: string } }>("/api/merchant/stores/:idx/charges", async (req): Res<"POST /api/merchant/stores/:idx/charges"> => {
    const run = currentRun(s);
    const m = storeIdx(run, req.params.idx);
    const body = ChargeInput.parse(req.body ?? {});
    return run.orders.propose(null, { store: m, lines: body.lines, origin: "counter", payer: "resident" });
  });
}
