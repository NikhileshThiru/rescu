import { ActionInput, type ApiRoutes } from "@rescu/live";
import type { FastifyInstance } from "fastify";
import { requirePresenter, type Services } from "../services.js";
import { OracleEngine } from "./engine.js";

type Res<R extends keyof ApiRoutes> = Promise<ApiRoutes[R]["res"]>;

/** Oracle routes (`/api/oracle/*`) and the engine that watches every run. */
export async function registerOracle(app: FastifyInstance, s: Services): Promise<void> {
  const engine = new OracleEngine(s);
  app.addHook("onClose", async () => engine.stop());

  app.get<{ Querystring: { status?: string } }>("/api/oracle/cases", async (req): Res<"GET /api/oracle/cases"> => engine.list(req.query.status || undefined));

  app.get<{ Params: { id: string } }>("/api/oracle/cases/:id", async (req): Res<"GET /api/oracle/cases/:id"> => engine.get(req.params.id));

  app.post<{ Params: { id: string } }>("/api/oracle/cases/:id/actions", async (req): Res<"POST /api/oracle/cases/:id/actions"> => {
    requirePresenter(req);
    const input = ActionInput.parse(req.body ?? {});
    return engine.act(req.params.id, input, "presenter");
  });

  app.get("/api/oracle/metrics", async (): Res<"GET /api/oracle/metrics"> => engine.metrics());
}
