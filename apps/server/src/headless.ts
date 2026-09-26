/**
 * End-to-end run without the web app: stage a storm on the local validator, declare, and let the
 * server clock play, printing throughput as it goes.
 *
 *   pnpm sim [slug] [--speed 5760] [--seconds 60] [--from -6]
 *
 * --from is hours relative to the main landfall where the declaration happens.
 * SIM_HOUSEHOLDS / SIM_MAX_TPS override the scale.
 */
import { loadavg } from "node:os";
import { ChainRunner } from "./chain.js";
import { config, loadKeys } from "./config.js";
import { Sim } from "./sim.js";
import { Tiger } from "./tiger.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const slug = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? config.defaultStorm;
const speed = flag("speed", 5_760);
const seconds = flag("seconds", 60);
const fromHours = flag("from", -6);

const chain = new ChainRunner(loadKeys());
const tiger = new Tiger(config.tigerUrl);
tiger.start();
const sim = new Sim(chain, tiger);

const reason = await sim.health();
if (reason) {
  console.error(`offline: ${reason}`);
  process.exit(1);
}
sim.offline = null;

const t0 = Date.now();
let lastLabel = "";
sim.on("run", () => {
  const p = sim.run?.progress;
  if (p && p.label !== lastLabel) {
    lastLabel = p.label;
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${p.label} (${p.total})`);
  }
});
console.log(`staging ${slug}: ${config.households} households, max ${config.maxTps} payments/s, load ${loadavg().map((x) => x.toFixed(1)).join(" ")}`);
await sim.stage(slug, true);
const run = await sim.staged();
const stageSecs = (Date.now() - t0) / 1000;
const W = run.world;
console.log(`staged in ${stageSecs.toFixed(1)} s: ${W.households.n} households, ${W.merchants.n} stores, budget $${(W.budgetCents / 100).toLocaleString("en-US")}`);

const start = Math.max(W.domain.start, W.domain.landfall + fromHours * 3600);
await sim.declare(start, speed, true);
console.log(`declared at landfall ${fromHours >= 0 ? "+" : ""}${fromHours} h, ${speed}x (${(speed / 3600).toFixed(1)} sim h/s), fund ${run.fundSignature}`);

const day = (t: number) => ((t - W.domain.landfall) / 86400).toFixed(1);
let prev = { ...run.stats };
let prevAt = Date.now();
const until = Date.now() + seconds * 1000;
while (Date.now() < until && run.phase === "live") {
  await new Promise((r) => setTimeout(r, 2_000));
  const s = run.stats;
  const dt = (Date.now() - prevAt) / 1000;
  const aidRate = (s.aidHouseholds - prev.aidHouseholds) / dt;
  const payRate = (s.payments + s.blocked - prev.payments - prev.blocked) / dt;
  console.log(
    `  day ${day(run.clock.now()).padStart(5)}  aid ${String(s.aidHouseholds).padStart(6)} (${aidRate.toFixed(0)}/s)  ` +
      `payments ${String(s.payments).padStart(7)} (${payRate.toFixed(0)}/s)  blocked ${s.blocked}  dropped ${s.dropped}  ` +
      `in flight ${chain.inFlight}  tiger ${tiger.rowsPerSec()} rows/s (${tiger.pending} pending)  load ${loadavg()[0]!.toFixed(1)}`,
  );
  prev = { ...s, blockedBy: { ...s.blockedBy } };
  prevAt = Date.now();
}

run.pause();
await new Promise((r) => setTimeout(r, 3_000));
await tiger.flush();
const q0 = performance.now();
const totals = await tiger.totals(run.key);
const queryMs = performance.now() - q0;
console.log("\nsummary (from Tiger continuous aggregates, %d ms):", Math.round(queryMs));
console.log(`  aid: ${totals.householdsPaid} households, $${totals.disbursedUsd.toLocaleString("en-US")}, time-to-aid p50 ${totals.timeToAidMs?.p50} ms p95 ${totals.timeToAidMs?.p95} ms`);
console.log(`  payments: ${totals.payments} landed ($${totals.spentUsd.toLocaleString("en-US")}), p50 latency ${totals.paymentLatencyMs} ms`);
console.log(`  blocked: ${totals.blocked}`, totals.blockedBy.map((b) => `${b.rule} ${b.count}`).join(", "));
console.log(`  by category:`, totals.spentByCategory.map((c) => `${c.category} $${Math.round(c.usd)}`).join(", "));
console.log(`  in memory: aid failed ${run.stats.aidFailed}, dropped ${run.stats.dropped}`);

sim.stop();
await tiger.stop();
process.exit(0);
