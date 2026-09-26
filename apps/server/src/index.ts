import cors from "@fastify/cors";
import { WS_PATH } from "@rescu/live";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { ChainRunner } from "./chain.js";
import { config, loadKeys } from "./config.js";
import { Hub } from "./hub.js";
import { Sim } from "./sim.js";
import { Tiger } from "./tiger.js";

const chain = new ChainRunner(loadKeys());
const tiger = new Tiger(config.tigerUrl);
tiger.start();
const sim = new Sim(chain, tiger);

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

app.get("/health", async () => {
  const run = sim.run;
  return {
    ok: !sim.offline,
    offline: sim.offline,
    run: run ? { id: run.key, slug: run.slug, phase: run.phase, stats: run.stats } : null,
    tiger: { ok: tiger.ok, rows: tiger.rows, rowsPerSec: tiger.rowsPerSec(), pending: tiger.pending },
    chainInFlight: chain.inFlight,
    connections: hub.connections,
  };
});

app.get("/run", async () => sim.info());

const wss = new WebSocketServer({ server: app.server, path: WS_PATH, perMessageDeflate: false });
const hub = new Hub(wss, sim, tiger);

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`rescu server on http://localhost:${config.port} (ws ${WS_PATH}), validator ${config.rpcUrl}`);
void sim.boot();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  sim.stop();
  hub.stop();
  wss.close();
  await app.close().catch(() => {});
  await tiger.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
