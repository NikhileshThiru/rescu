import type { FastifyInstance } from "fastify";
import { config } from "./config.js";

/** Methods that change the chain or cost us resources: the public proxy never forwards them. */
const DENY = new Set(["sendTransaction", "requestAirdrop", "simulateTransaction", "minimumLedgerSlot"]);
const MAX_BATCH = 50;

/**
 * Read-only JSON-RPC in front of our validator (rpc.rescu.tech -> here), so Solana Explorer's
 * custom-cluster links can show every transaction without the public being able to send or
 * airdrop on it. The sim server itself talks to the validator directly.
 */
export async function registerRpcProxy(app: FastifyInstance): Promise<void> {
  app.post("/rpc", async (req, reply) => {
    const body = req.body as unknown;
    const calls = Array.isArray(body) ? body : [body];
    if (!calls.length || calls.length > MAX_BATCH) return reply.status(400).send({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid request" }, id: null });
    for (const c of calls) {
      const method = (c as { method?: unknown })?.method;
      if (typeof method !== "string" || DENY.has(method)) {
        return reply.status(403).send({ jsonrpc: "2.0", error: { code: -32601, message: `${String(method)} isn't available on this public endpoint` }, id: (c as { id?: unknown })?.id ?? null });
      }
    }
    const res = await fetch(config.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    reply.status(res.status).header("content-type", "application/json");
    return reply.send(await res.text());
  });
}
