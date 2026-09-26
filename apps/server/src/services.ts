import { timingSafeEqual } from "node:crypto";
import { PRESENTER_HEADER } from "@rescu/live";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { ChainRunner } from "./chain.js";
import { config } from "./config.js";
import type { Grok } from "./grok.js";
import type { Hub } from "./hub.js";
import { ApiFail } from "./network/errors.js";
import type { AppResident } from "./network/residents.js";
import type { Run } from "./run.js";
import type { Sim } from "./sim.js";
import type { Tiger } from "./tiger.js";

export { ApiFail };

/** Everything a route module gets. `sim.run` is the one live network (it changes on reset / storm switch). */
export interface Services {
  sim: Sim;
  chain: ChainRunner;
  tiger: Tiger;
  hub: Hub;
  grok: Grok;
}

/** The current run, or a 409 when nothing is staged. */
export function currentRun(s: Services): Run {
  const run = s.sim.run;
  if (!run || run.phase === "offline" || run.phase === "staging") {
    throw new ApiFail(409, "no_run", run?.phase === "staging" ? "The relief network is still being staged" : "No relief network is running");
  }
  return run;
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** True when `key` is the presenter key, or when none is configured (local dev). Constant-time. */
export function isPresenter(key: string | null | undefined): boolean {
  const want = config.presenterKey;
  if (!want) return true;
  if (!key) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Routes that change the shared demo (oracle actions, prices, break-it) call this first. */
export function requirePresenter(req: FastifyRequest) {
  const h = req.headers[PRESENTER_HEADER];
  if (!isPresenter(Array.isArray(h) ? h[0] : h)) throw new ApiFail(403, "presenter_only", "View only: the presenter runs this part of the demo.");
}

/** The resident behind `Authorization: Bearer <token>` in the current run, or a 401. */
export function residentOf(s: Services, req: FastifyRequest): { run: Run; resident: AppResident } {
  const run = currentRun(s);
  const resident = run.people.fromToken(bearer(req));
  if (!resident) throw new ApiFail(401, "unauthorized", "Session expired or unknown (a new run started?). Pick a resident again.");
  return { run, resident };
}

/** Turns ApiFail and zod errors into `{ error, code }`, unknown routes too. Registered once in index.ts. */
export function installErrorHandler(app: FastifyInstance) {
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => reply.status(404).send({ error: `No route ${req.method} ${req.url.split("?")[0]}`, code: "not_found" }));
  app.setErrorHandler((err: unknown, _req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiFail) return reply.status(err.status).send(err.body());
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ error: first ? `${first.path.join(".") || "body"}: ${first.message}` : "Invalid request", code: "bad_request" });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message ?? "Bad request", code: "bad_request" });
    console.error("route error:", err);
    return reply.status(500).send({ error: e.message ?? "Server error", code: "server_error" });
  });
}
