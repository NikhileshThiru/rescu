import {
  AllowanceInput,
  type ApiRoutes,
  ChatInput,
  ConfirmOrderInput,
  JoinInput,
  ListStoresInput,
  ProposeOrderInput,
  RelayInput,
  SearchItemsInput,
} from "@rescu/live";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { Agent } from "../agent/agent.js";
import { runEnv } from "../agent/env.js";
import { RateLimiter } from "../agent/ratelimit.js";
import { Market } from "../network/market.js";
import { ApiFail, bearer, currentRun, residentOf, type Services } from "../services.js";
import { registerMcp } from "./mcp.js";
import { getStore, listStores, proposeOrder, searchItems } from "./tools.js";

type Handler<R extends keyof ApiRoutes> = (req: FastifyRequest, reply: FastifyReply) => Promise<ApiRoutes[R]["res"]>;

/** Registers one contract route; the handler's return type is checked against ApiRoutes. */
function route<R extends keyof ApiRoutes>(app: FastifyInstance, r: R, handler: Handler<R>) {
  const space = r.indexOf(" ");
  const method = r.slice(0, space) as "GET" | "POST" | "PATCH";
  app.route({ method, url: r.slice(space + 1), handler });
}

const IdParam = z.object({ id: z.string().min(1).max(64) });
const IdxParam = z.object({ idx: z.coerce.number().int().min(0) });
const ResidentParam = z.object({ resident: z.coerce.number().int().min(0) });
const LatLonQuery = z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) });
const ProposeBody = ProposeOrderInput.extend({ origin: z.enum(["shop", "agent"]).optional() });
const ConfirmBody = ConfirmOrderInput.omit({ orderId: true });

/**
 * Relief Market routes (`/api/market/*` in @rescu/live's ApiRoutes), the MCP server at /mcp and
 * the Grok agent. Owner: step 5.
 */
export async function registerMarket(app: FastifyInstance, s: Services): Promise<void> {
  const agent = new Agent(s.grok);
  const limiter = new RateLimiter(10, 40, 5 * 60_000);

  // ---- residents ----
  route(app, "GET /api/market/personas", async () => currentRun(s).people.personas());

  route(app, "POST /api/market/personas/:resident/claim", async (req) => {
    const { resident } = ResidentParam.parse(req.params);
    return currentRun(s).people.claim(resident);
  });

  route(app, "GET /api/market/eligibility", async (req) => {
    const { lat, lon } = LatLonQuery.parse(req.query);
    return currentRun(s).people.eligibility(lat, lon);
  });

  route(app, "POST /api/market/join", async (req) => {
    const input = JoinInput.parse(req.body);
    return currentRun(s).people.join(input);
  });

  route(app, "GET /api/market/wallet", async (req) => {
    const { run, resident } = residentOf(s, req);
    return run.people.wallet(resident);
  });

  route(app, "POST /api/market/agent/allowance", async (req) => {
    const { run, resident } = residentOf(s, req);
    const { allowanceCents } = AllowanceInput.parse(req.body);
    return run.people.setAllowance(resident, allowanceCents);
  });

  route(app, "POST /api/market/relay/:id", async (req) => {
    const { run, resident } = residentOf(s, req);
    const { id } = IdParam.parse(req.params);
    const { signatureB64 } = RelayInput.parse(req.body);
    return run.people.relay(resident, id, signatureB64);
  });

  // ---- shopping ----
  route(app, "GET /api/market/catalog", async () => Market.catalog());

  route(app, "POST /api/market/search", async (req) => {
    const { run, resident } = residentOf(s, req);
    return searchItems(run, resident, SearchItemsInput.parse(req.body ?? {}));
  });

  route(app, "POST /api/market/stores", async (req) => {
    const { run, resident } = residentOf(s, req);
    return listStores(run, resident, ListStoresInput.parse(req.body ?? {}));
  });

  route(app, "GET /api/market/stores/:idx", async (req) => {
    const run = currentRun(s);
    const { idx } = IdxParam.parse(req.params);
    // Public; a resident's token adds the distance from their home.
    const me = run.people.fromToken(bearer(req));
    return getStore(run, idx, me ? { lat: me.lat, lon: me.lon } : undefined);
  });

  route(app, "POST /api/market/orders", async (req) => {
    const { run, resident } = residentOf(s, req);
    const { origin, ...input } = ProposeBody.parse(req.body);
    return proposeOrder(run, resident, input, origin ?? "shop");
  });

  route(app, "GET /api/market/orders", async (req) => {
    const { run, resident } = residentOf(s, req);
    return run.orders.forResident(resident.idx, 30);
  });

  route(app, "GET /api/market/orders/:id", async (req) => {
    const { id } = IdParam.parse(req.params);
    const o = currentRun(s).orders.get(id);
    if (!o) throw new ApiFail(404, "not_found", "No such order (it may be from an earlier run)");
    return o;
  });

  route(app, "POST /api/market/orders/:id/confirm", async (req) => {
    const { run, resident } = residentOf(s, req);
    const { id } = IdParam.parse(req.params);
    const { payer } = ConfirmBody.parse(req.body ?? {});
    return run.orders.confirm(id, resident, payer);
  });

  route(app, "POST /api/market/orders/:id/cancel", async (req) => {
    const { run, resident } = residentOf(s, req);
    const { id } = IdParam.parse(req.params);
    return run.orders.cancel(id, resident);
  });

  route(app, "POST /api/market/agent/chat", async (req, reply) => {
    const { run, resident } = residentOf(s, req);
    const input = ChatInput.parse(req.body);
    const key = `${run.key}:${resident.idx}`;
    if (!limiter.take(key)) {
      reply.header("retry-after", String(limiter.retryAfter(key)));
      throw new ApiFail(429, "rate_limited", "Grok is getting a lot of requests. Give it a minute and ask again.");
    }
    return agent.chat(runEnv(run, resident), input);
  });

  registerMcp(app, s);
}
