import { BREAK_CASES, type BreakCaseId, type BreakitState, type BreakResult } from "@rescu/live";
import type { FastifyInstance } from "fastify";
import { ApiFail, type Services } from "../services.js";
import { Sandbox } from "./sandbox.js";

/**
 * "Try to break it" (`/api/breakit*`): a sandbox declaration on our validator and one real attack
 * per case. The sandbox is staged in the background at boot and survives sim resets.
 */
export async function registerBreakit(app: FastifyInstance, s: Services): Promise<void> {
  const sandbox = new Sandbox(s.chain);
  sandbox.start();
  app.addHook("onClose", async () => sandbox.stop());

  app.get("/api/breakit", async (): Promise<BreakitState> => sandbox.state());

  app.post<{ Params: { id: string } }>("/api/breakit/:id", async (req): Promise<BreakResult> => {
    const c = BREAK_CASES.find((x) => x.id === req.params.id);
    if (!c) throw new ApiFail(404, "not_found", `No attack called "${req.params.id}"`);
    if (!sandbox.isReady) throw new ApiFail(409, "not_ready", `The sandbox isn't ready yet: ${sandbox.status}`);
    const r = await sandbox.run(c.id as BreakCaseId);
    // The attack shows in the live feed too (never in the run's numbers: it's the sandbox's declaration).
    if (r.signature) {
      s.sim.run?.noteBreakit({
        kind: r.landed ? "payment" : "blocked",
        signature: r.signature,
        simT: s.sim.run.clock.now(),
        usd: 0,
        title: `Try to break it · ${c.title}`,
        detail: r.message,
        rule: r.rule,
        latencyMs: r.latencyMs,
      });
    }
    return r;
  });
}
