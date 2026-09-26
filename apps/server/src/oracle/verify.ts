/**
 * End-to-end check of the oracle on the local validator, no web app:
 *   price hike at the terminal -> gouging case within ~2 s (Grok or template write-up) ->
 *   suspend on-chain -> the persona's next payment is refused (MerchantSuspended); then the sim
 *   runs fast and the planted bad actors are scored against the cases (precision / recall).
 *
 *   SIM_HOUSEHOLDS=3000 SIM_MERCHANTS_MAX=200 npx tsx src/oracle/verify.ts [--seconds 90] [--no-grok]
 */
import { ChainRunner } from "../chain.js";
import { config, loadKeys } from "../config.js";
import { Grok } from "../grok.js";
import type { Hub } from "../hub.js";
import type { Services } from "../services.js";
import { Sim } from "../sim.js";
import { Tiger } from "../tiger.js";
import { OracleEngine } from "./engine.js";

const args = process.argv.slice(2);
const seconds = Number(args[args.indexOf("--seconds") + 1] || 90) || 90;
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failed++;
  log(ok ? "PASS" : "FAIL", what);
};
const count = (xs: string[]) => xs.reduce((a, k) => ({ ...a, [k]: (a[k] ?? 0) + 1 }), {} as Record<string, number>);

const chain = new ChainRunner(loadKeys());
const tiger = new Tiger(config.tigerUrl);
tiger.start();
const sim = new Sim(chain, tiger);
const reason = await sim.health();
if (reason) throw new Error(reason);
sim.offline = null;
const published: string[] = [];
const hub = { publish: (m: { type: string }) => published.push(m.type), addSnapshot: () => {} } as unknown as Hub;
const grok = args.includes("--no-grok") ? new Grok({ apiKey: "", baseUrl: "", agentModel: "x", oracleModel: "x", limitUsd: 0 }) : Grok.fromEnv();
const s: Services = { sim, chain, tiger, hub, grok };
const engine = new OracleEngine(s);

await sim.stage(config.defaultStorm, true);
const run = await sim.staged();
engine.attach(run);
log(`staged ${run.world.households.n} households, ${run.world.merchants.n} stores; planted ${JSON.stringify(count(run.world.planted.map((p) => p.kind)))}`);

// Our own books for --dump (tuning data), independent of the engine.
const books = new Map<number, { orders: number; spent: number; caps: number; byStore: Map<number, number>; first: number }>();
run.on("payment", (e) => {
  const b = books.get(e.resident) ?? { orders: 0, spent: 0, caps: 0, byStore: new Map(), first: e.simT };
  if (e.ok) {
    b.orders++;
    b.spent += e.cents;
    b.byStore.set(e.merchant, (b.byStore.get(e.merchant) ?? 0) + e.cents);
  } else if (e.rule === "OverDailyCap" || e.rule === "OverOrderCap") b.caps++;
  books.set(e.resident, b);
});

const p0 = run.people.personas()[0]!;
await sim.declare(p0.aidDueAt - 3600, 17_280, true);
const session = run.people.claim(p0.resident);
const me = run.people.fromToken(session.token)!;
while (Number.isNaN(run.people.fundedAt(me))) await sleep(200);
run.setSpeed(60);
log(`${p0.name}'s aid landed`);

// ---- the demo loop ----
const offer = run.market.search({ query: "water" }, run.clock.now(), { lat: me.lat, lon: me.lon })[0]!;
const m = offer.store.idx;
const before = run.market.price(m, offer.item.itemId, run.clock.now());
const tHike = Date.now();
run.setPrice(m, offer.item.itemId, before * 4);
let c = engine.list().find((x) => x.id === `gouge-${m}`);
while (!c && Date.now() - tHike < 5_000) {
  await sleep(50);
  c = engine.list().find((x) => x.id === `gouge-${m}`);
}
check(!!c, `gouging case opened ${Date.now() - tHike} ms after the price hike: ${c?.title} (score ${c?.score}, ${c?.severity})`);
check(run.market.caseOf[m] === c?.id, "store flagged (amber on the map)");
const tSum = Date.now();
while (c && c.summary.status === "pending" && Date.now() - tSum < 20_000) await sleep(100);
check(!!c && (c.summary.status === "ready" || c.summary.status === "fallback"), `summary ${c?.summary.status} (${c?.summary.model ?? "template"}) in ${Date.now() - tSum} ms: ${c?.summary.text}`);
const acted = await engine.act(c!.id, { kind: "suspend_merchant" });
const rec = acted.actions.at(-1)!;
check(acted.status === "actioned" && rec.ok && !!rec.signature && run.market.status[m] === "suspended", `suspended on-chain ${rec.signature}`);
const o = await run.orders.propose(me, { store: m, lines: [{ itemId: offer.item.itemId, qty: 1 }], origin: "shop" });
const paid = await run.orders.confirm(o.id, me, "resident");
check(paid.order.status === "rejected" && paid.order.rule === "MerchantSuspended", `next payment to the store refused: ${paid.order.rule} (${paid.order.message})`);
check(published.filter((p) => p === "case").length >= 2, `case messages published: ${published.filter((p) => p === "case").length}`);

// ---- planted bad actors ----
run.setSpeed(17_280);
const end = Date.now() + seconds * 1000;
while (Date.now() < end && run.phase === "live") {
  await sleep(10_000);
  const mt = engine.metrics();
  const day = ((run.clock.now() - run.world.domain.landfall) / 86_400).toFixed(1);
  log(
    `day ${day}: cases ${JSON.stringify(Object.fromEntries(mt.cases.map((k) => [k.kind, k.open + k.actioned])))} planted caught ${mt.planted.map((p) => `${p.kind} ${p.caught}/${p.total}`).join(", ")}; precision ${mt.precision} recall ${mt.recall}; scan ${mt.lastScanMs} ms (${mt.scans} scans); grok ${mt.grok.summaries} summaries $${mt.grok.usd}`,
  );
}
const mt = engine.metrics();
const planted = run.world.planted;
const plantedR = new Set(planted.flatMap((p) => p.residents));
const plantedM = new Set(planted.flatMap((p) => p.merchants));
for (const x of engine.list()) {
  const truth = x.subjects.some((sub) => (sub.kind === "merchant" ? plantedM.has(sub.idx) : plantedR.has(sub.idx)));
  log(`${truth ? "TP" : "FP"} ${x.kind.padEnd(18)} ${x.score.toFixed(2)} anomaly ${x.anomaly ?? "-"} ${x.title}`);
}
if (args.includes("--dump")) {
  const { writeFileSync } = await import("node:fs");
  const H = run.world.households;
  const rows = [...books].map(([r, b]) => {
    let top = -1;
    let topC = 0;
    for (const [mm, cc] of b.byStore) if (cc > topC) [top, topC] = [mm, cc];
    return { r, fraud: r < H.n ? H.fraud[r] : -1, rogue: r < H.n ? H.rogue[r] : -1, aid: r < H.n ? H.aidCents[r] : 0, orders: b.orders, spent: b.spent, caps: b.caps, top, topC, stores: b.byStore.size, collude: r < H.n ? H.colludeWith[r] : -1 };
  });
  const stores = Array.from({ length: run.world.merchants.n }, (_, i) => ({ m: i, cat: run.world.merchants.category[i], vol: run.market.salesCents[i], pays: run.market.payments[i], planted: run.world.planted.filter((p) => p.merchants.includes(i)).map((p) => p.kind).join(",") }));
  writeFileSync(args[args.indexOf("--dump") + 1]!, JSON.stringify({ rows, stores }));
  log("dumped");
}
log(`final: precision ${mt.precision} recall ${mt.recall} last scan ${mt.lastScanMs} ms; model ${JSON.stringify(mt.model)}`);
log(failed ? `${failed} FAILED` : "all passed");
engine.stop();
sim.stop();
await tiger.stop();
process.exit(failed ? 1 : 0);
