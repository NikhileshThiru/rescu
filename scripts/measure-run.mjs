#!/usr/bin/env node
/**
 * One measured full run against a sim server: reset (fresh staging), declare Helene 6 h before
 * landfall at 4x, sample the live KPIs every second until the Day 30 close-out, then print the
 * numbers the pitch quotes (staging time, time to aid, tx/s, payment confirm, Tiger query ms,
 * blocked by rule, reconciliation, oracle precision/recall, Grok spend).
 *
 *   node scripts/measure-run.mjs [--server http://localhost:4000] [--key <presenter key>] [--out run.json]
 *
 * Drops the current run (a presenter "Run it again"), so don't use it mid-demo.
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SERVER = opt("server", "http://localhost:4000").replace(/\/$/, "");
const KEY = opt("key", process.env.PRESENTER_KEY ?? "");
const OUT = opt("out");
const SLUG = "helene-2024";
const SPEED = 5_760; // 4x replay
const DECLARE_BEFORE_LANDFALL = 6 * 3600;

const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(7)} s`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => (await fetch(`${SERVER}${path}`)).json();
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const storm = JSON.parse(readFileSync(new URL(`../apps/web/public/data/${SLUG}.json`, import.meta.url), "utf8")).storm;
const landfall = storm.landfalls.reduce((a, b) => ((b.vmax ?? 0) > (a.vmax ?? 0) ? b : a)).t;

let run = null;
let phase = null;
const kpis = [];
const ws = new WebSocket(`${SERVER.replace(/^http/, "ws")}/ws`);
const send = (m) => ws.send(JSON.stringify(m));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === "hello" || m.type === "run") {
    run = m.run ?? run;
    if (run && run.phase !== phase) {
      phase = run.phase;
      log(`phase ${phase}`);
    }
  }
  if (m.type === "kpis" && !m.kpis.history && m.runId === run?.id) kpis.push({ at: Date.now(), ...m.kpis });
  if (m.type === "error") log("server error:", m.message ?? JSON.stringify(m));
};
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
if (KEY) send({ type: "auth", key: KEY });
await sleep(500);

log(`reset: staging a fresh ${SLUG} run`);
const oldId = run?.id;
const stageStart = Date.now();
send({ type: "reset" });
await sleep(1_000);
while (!(run?.id !== oldId && run?.slug === SLUG && run.phase === "ready")) {
  if (run?.slug !== SLUG && run?.phase === "ready") send({ type: "stage", slug: SLUG });
  await sleep(500);
}
const stagingS = (Date.now() - stageStart) / 1000;
log(`staged ${run.households} households + ${run.merchants} stores in ${stagingS.toFixed(1)} s`);

const declareAt = Date.now();
kpis.length = 0;
send({ type: "declare", t: landfall - DECLARE_BEFORE_LANDFALL, speed: SPEED, playing: true });
let lastLog = 0;
while (run.phase !== "ended") {
  await sleep(1_000);
  const k = kpis.at(-1);
  if (k && Date.now() - lastLog > 30_000) {
    lastLog = Date.now();
    log(`day ${((k.simT - landfall) / 86_400).toFixed(1)}: ${k.householdsPaid} paid, ${k.payments} purchases, ${k.txPerSec} tx/s, time to aid ${JSON.stringify(k.timeToAidMs)}, tiger ${k.tiger.queryMs} ms`);
  }
}
const wallS = (Date.now() - declareAt) / 1000;
await sleep(2_000);

const health = await get("/health");
const oracle = await get("/api/oracle/metrics");
const last = kpis.at(-1);
const liveKpis = kpis.filter((k) => k.at < declareAt + wallS * 1000);
const tigerMs = liveKpis.map((k) => k.tiger.queryMs).filter((x) => x > 0);
const s = health.run.stats;
const result = {
  server: SERVER,
  at: new Date().toISOString(),
  households: run.households,
  merchants: run.merchants,
  stagingS: +stagingS.toFixed(1),
  declaredHoursBeforeLandfall: DECLARE_BEFORE_LANDFALL / 3600,
  speed: SPEED,
  wallMinutes: +(wallS / 60).toFixed(1),
  timeToAidMs: last?.timeToAidMs,
  aidHouseholds: s.aidHouseholds,
  aidUsd: s.aidCents / 100,
  aidFailed: s.aidFailed,
  payments: s.payments,
  spentUsd: s.spentCents / 100,
  returnedUsd: s.returnedCents / 100,
  reconciles: s.aidCents === s.spentCents + s.returnedCents,
  blocked: s.blocked,
  blockedBy: s.blockedBy,
  dropped: s.dropped,
  peakTxPerSec: Math.max(0, ...liveKpis.map((k) => k.txPerSec)),
  paymentConfirmMsP50: pct(liveKpis.map((k) => k.paymentLatencyMs).filter((x) => x != null), 50),
  tiger: {
    queryMsP50: pct(tigerMs, 50),
    queryMsP95: pct(tigerMs, 95),
    samples: tigerMs.length,
    peakRowsPerSec: Math.max(0, ...liveKpis.map((k) => k.tiger.rowsPerSec)),
    compressionPct: last?.tiger.compressionPct ?? null,
  },
  spentByCategory: last?.spentByCategory,
  oracle: {
    precision: oracle.precision,
    recall: oracle.recall,
    planted: oracle.planted,
    lastScanMs: oracle.lastScanMs,
    summaries: oracle.grok.summaries,
    summariesUsd: oracle.grok.usd,
  },
  grokSpentUsd: health.grok.spentUsd,
};
console.log(JSON.stringify(result, null, 2));
if (OUT) writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
ws.close();
