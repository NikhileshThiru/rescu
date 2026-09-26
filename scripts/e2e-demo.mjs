#!/usr/bin/env node
/**
 * Black-box check of the whole demo loop against a running sim server, through the public
 * surfaces only (REST, WebSocket, MCP), exactly as the web pages and outside agents use them:
 *
 *   declare Helene -> persona's aid lands -> Grok proposes -> agent pays -> arc (spotlight) ->
 *   merchant raises a price -> oracle opens a gouging case -> suspend on-chain -> the same order
 *   is refused by the chain -> every "Try to break it" case -> a phone-key resident joins and pays
 *   by signing -> counter QR charge -> MCP agent session -> duplicate registration case.
 *
 *   node scripts/e2e-demo.mjs [--server http://localhost:4000] [--no-grok] [--skip breakit,mcp]
 *
 * Needs a server whose run is staged (ready) or live. Declares it if ready. Exit code 1 on any FAIL.
 */
import { webcrypto } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SERVER = opt("server", process.env.RESCU_SERVER ?? "http://localhost:4000").replace(/\/$/, "");
const NO_GROK = args.includes("--no-grok");
const SKIP = new Set((opt("skip", "") ?? "").split(",").filter(Boolean));
const WS_URL = `${SERVER.replace(/^http/, "ws")}/ws`;

const t0 = Date.now();
const results = [];
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`, ...a);
function check(ok, what, detail = "") {
  results.push({ ok: !!ok, what, detail });
  log(ok ? "PASS" : "FAIL", what, detail);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { body, token, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const started = performance.now();
  const res = await fetch(`${SERVER}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const ms = Math.round(performance.now() - started);
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (raw) return { status: res.status, data, ms };
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${data?.code ?? ""} ${data?.error ?? text.slice(0, 200)}`), { status: res.status, data });
  return data;
}

async function until(what, fn, { timeoutMs = 30_000, everyMs = 300 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

// ---------- WebSocket: everything the Command Center sees ----------

const seen = { spotlight: [], cases: new Map(), stores: new Map(), feed: [], clock: null, run: null };
const ws = new WebSocket(WS_URL);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error(`can't open ${WS_URL}`));
});
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  switch (msg.type) {
    case "hello":
    case "run":
      seen.run = msg.run;
      break;
    case "clock":
      seen.clock = msg.clock;
      break;
    case "batch":
      seen.spotlight.push(...(msg.batch.spotlight ?? []));
      seen.feed.push(...msg.batch.feed);
      break;
    case "cases":
      for (const c of msg.cases) seen.cases.set(c.id, c);
      break;
    case "case":
      seen.cases.set(msg.case.id, msg.case);
      break;
    case "stores":
      for (const s of msg.states) seen.stores.set(s.idx, s);
      break;
    case "store":
      seen.stores.set(msg.state.idx, msg.state);
      break;
  }
};
const send = (msg) => ws.send(JSON.stringify(msg));

// ---------- 1. the run ----------

let run = await until("a staged run", async () => {
  const r = await api("GET", "/run");
  log(`run ${r.id || "-"} ${r.stormName} phase=${r.phase}${r.progress ? ` (${r.progress.label} ${r.progress.done}/${r.progress.total})` : ""}`);
  return r.phase === "ready" || r.phase === "live" ? r : null;
}, { timeoutMs: 240_000, everyMs: 3_000 });
check(true, `run ${run.id}: ${run.households} households, ${run.merchants} stores, budget $${run.budgetUsd.toLocaleString("en-US")}`);

const personas = await api("GET", "/api/market/personas");
check(Array.isArray(personas) && personas.length === 6, `6 personas: ${personas.map((p) => `${p.name} (${p.county})`).join(", ")}`);
const p0 = personas.find((p) => !p.claimed) ?? personas[0];

let declaredAt = null;
if (run.phase === "ready") {
  declaredAt = Date.now();
  send({ type: "declare", t: p0.aidDueAt - 2 * 3600, speed: 17_280, playing: true });
  run = await until("the run to go live and funded", async () => {
    const r = await api("GET", "/run");
    return r.phase === "live" && r.funded ? r : null;
  });
  check(!!run.fundSignature, `declared + funded on-chain (${Date.now() - declaredAt} ms)`, run.fundSignature);
}

// ---------- 2. persona: aid lands ----------

const session = await api("POST", `/api/market/personas/${p0.resident}/claim`);
const token = session.token;
check(!!token && session.resident === p0.resident, `claimed ${p0.name}`);
let wallet = await until("the persona's aid to land", async () => {
  const w = await api("GET", "/api/market/wallet", { token });
  return w.aid.landed ? w : null;
}, { timeoutMs: 90_000, everyMs: 400 });
check(wallet.balanceCents === p0.aidCents, `aid landed: $${wallet.balanceCents / 100}, time to aid ${wallet.aid.timeToAidMs} ms`, wallet.aid.signature);
send({ type: "speed", speed: 1_440 });

// ---------- 3. Grok proposes, the agent pays ----------

const allowance = await api("POST", "/api/market/agent/allowance", { token, body: { allowanceCents: 15_000 } });
check(allowance.wallet?.agent.approved && allowance.wallet.agent.allowanceCents === 15_000, "Grok allowance $150 granted on-chain", allowance.wallet?.agent.signature);

let order = null;
if (!NO_GROK) {
  const started = Date.now();
  const chat = await api("POST", "/api/market/agent/chat", {
    token,
    body: { messages: [{ role: "user", content: `Storm hit. We're ${p0.size} people, out of water and food, no power.` }] },
  }).catch((e) => ({ error: e.message }));
  if (chat.error) check(false, "Grok chat turn", chat.error);
  else {
    check(chat.orders.length > 0, `Grok proposed ${chat.orders.length} order(s) in ${Date.now() - started} ms${chat.fallback ? " (FALLBACK planner)" : ""}, $${chat.usage.usd.toFixed(4)}`, chat.reply.slice(0, 160));
    check(!chat.fallback, "Grok answered (not the fallback)", chat.model);
    order = chat.orders[0] ?? null;
  }
}
if (!order) {
  const offers = await api("POST", "/api/market/search", { token, body: { query: "water" } });
  check(offers.length > 0, `search water: nearest ${offers[0]?.store.name} ${offers[0]?.store.distanceKm} km`);
  order = await api("POST", "/api/market/orders", { token, body: { store: offers[0].store.idx, lines: [{ itemId: offers[0].item.itemId, qty: 2 }], origin: "agent" } });
}
check(order.status === "proposed" && order.totalCents <= 20_000, `proposed at ${order.storeName}: $${(order.totalCents / 100).toFixed(2)} (${order.lines.map((l) => `${l.qty}x ${l.name}`).join(", ")})`);
const spotBefore = seen.spotlight.length;
const confirmed = await api("POST", `/api/market/orders/${order.id}/confirm`, { token, body: { payer: "agent" } });
check(confirmed.order.status === "paid", `agent paid on-chain in ${confirmed.order.latencyMs} ms`, confirmed.order.signature ?? confirmed.order.message);
await until("the order's arc on the Command Center (spotlight)", async () => seen.spotlight.slice(spotBefore).some((s) => s.kind === "order" && s.resident === p0.resident), { timeoutMs: 5_000 })
  .then(() => check(true, "spotlight arc reached the Command Center over the WebSocket"))
  .catch((e) => check(false, "spotlight arc on the WebSocket", e.message));
const store = confirmed.order.store;

// ---------- 4. merchant raises a price -> oracle -> suspend -> refused ----------

const detail = await api("GET", `/api/merchant/stores/${store}`);
const target = detail.listings.find((l) => l.itemId === confirmed.order.lines[0].itemId) ?? detail.listings.find((l) => l.need === "water") ?? detail.listings[0];
const hikeAt = Date.now();
const listing = await api("PATCH", `/api/merchant/stores/${store}/prices`, { body: { itemId: target.itemId, priceCents: target.preStormCents * 4 } });
check(listing.priceCents === target.preStormCents * 4, `merchant raised ${target.name}: $${(target.preStormCents / 100).toFixed(2)} -> $${(listing.priceCents / 100).toFixed(2)}`);
const gougeCase = await until("a gouging case for the store", async () => {
  const cases = await api("GET", "/api/oracle/cases");
  return cases.find((c) => c.kind === "gouging" && c.subjects.some((s) => s.kind === "merchant" && s.idx === store) && c.status === "open");
}, { timeoutMs: 15_000, everyMs: 250 }).catch((e) => (check(false, "oracle opened a gouging case", e.message), null));
if (gougeCase) {
  check(true, `oracle flagged gouging in ${Date.now() - hikeAt} ms: "${gougeCase.title}" score ${gougeCase.score.toFixed(2)}`);
  check(seen.cases.has(gougeCase.id), "case pushed to the Command Center over the WebSocket");
  check(seen.stores.get(store)?.flagged === true, "store flagged (amber) over the WebSocket");
  const summarized = await until("the case summary", async () => {
    const c = await api("GET", `/api/oracle/cases/${gougeCase.id}`);
    return c.summary.status !== "pending" ? c : null;
  }, { timeoutMs: 20_000 }).catch(() => null);
  check(summarized && summarized.summary.text, `case summary (${summarized?.summary.status}, ${summarized?.summary.model ?? "-"})`, summarized?.summary.text?.slice(0, 200));
  const acted = await api("POST", `/api/oracle/cases/${gougeCase.id}/actions`, { body: { kind: "suspend_merchant" } });
  const rec = acted.actions.at(-1);
  check(acted.status === "actioned" && rec?.ok && rec.signature, "store suspended on-chain by the oracle key", rec?.signature);
  await until("suspended state on the WebSocket", async () => seen.stores.get(store)?.status === "suspended", { timeoutMs: 5_000 })
    .then(() => check(true, "store shows suspended (red) on the Command Center"))
    .catch((e) => check(false, "suspended state on the WebSocket", e.message));
}
const again = await api("POST", "/api/market/orders", { token, body: { store, lines: confirmed.order.lines.map((l) => ({ itemId: l.itemId, qty: 1 })), origin: "shop" } });
const refused = await api("POST", `/api/market/orders/${again.id}/confirm`, { token, body: { payer: "resident" } });
check(refused.order.status === "rejected" && refused.order.rule === "MerchantSuspended", `"Buy again" refused by the chain: ${refused.order.rule}`, refused.order.signature ?? "");
const after = await api("POST", "/api/market/search", { token, body: { query: target.name.split(",")[0] } });
check(!after.some((o) => o.store.idx === store), "suspended store no longer in search (Grok won't pick it)");

// ---------- 5. Try to break it ----------

if (!SKIP.has("breakit")) {
  const state = await until("the break-it sandbox", async () => {
    const s = await api("GET", "/api/breakit");
    if (!s.ready) log(`break-it: ${s.status}`);
    return s.ready ? s : null;
  }, { timeoutMs: 180_000, everyMs: 3_000 }).catch((e) => (check(false, "break-it sandbox ready", e.message), null));
  if (state) {
    for (const c of state.cases) {
      const r = await api("POST", `/api/breakit/${c.id}`).catch((e) => ({ error: e.message }));
      if (r.error) check(false, `break-it ${c.id}`, r.error);
      else check(r.asExpected && (c.expect ? !r.landed && r.signature : r.landed), `break-it ${c.id}: ${r.landed ? "landed" : r.rule} (${r.latencyMs} ms)`, r.signature ?? "no signature");
    }
  }
}

// ---------- 6. "I live here": a phone key joins and pays by signing ----------

const b58 = (bytes) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
};
const keys = await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey));
const spot = personas[1];
const el = await api("GET", `/api/market/eligibility?lat=${spot.lat}&lon=${spot.lon}`);
check(el.eligible, `eligible at ${el.county}: $${el.aidCents / 100}`);
const gt = await api("GET", "/api/market/eligibility?lat=33.7756&lon=-84.3963");
log(`Georgia Tech: eligible=${gt.eligible} ${gt.reason ?? ""} -> suggestion ${gt.suggestion?.county ?? "none"}`);
const deviceId = `dev_e2e_${Date.now().toString(36)}`;
const joinedAt = Date.now();
const phone = await api("POST", "/api/market/join", { body: { lat: spot.lat, lon: spot.lon, name: "Judge J.", pubkey: b58(pub), identity: { deviceId, phone: "(404) 555-0199" } } });
check(phone.custody === "device", "phone key registered on-chain (device custody)");
send({ type: "speed", speed: 17_280 });
const pw = await until("the phone's aid", async () => {
  const w = await api("GET", "/api/market/wallet", { token: phone.token });
  return w.aid.landed ? w : null;
}, { timeoutMs: 90_000, everyMs: 400 }).catch((e) => (check(false, "phone aid landed", e.message), null));
send({ type: "speed", speed: 1_440 });
if (pw) {
  check(pw.balanceCents === el.aidCents, `phone aid landed $${pw.balanceCents / 100} ${Date.now() - joinedAt} ms after joining (time to aid ${pw.aid.timeToAidMs} ms)`);
  const offers = await api("POST", "/api/market/search", { token: phone.token, body: { query: "bread" } });
  const o = await api("POST", "/api/market/orders", { token: phone.token, body: { store: offers[0].store.idx, lines: [{ itemId: offers[0].item.itemId, qty: 1 }], origin: "shop" } });
  const c = await api("POST", `/api/market/orders/${o.id}/confirm`, { token: phone.token, body: { payer: "resident" } });
  check(!!c.sign, "server returned a transaction for the phone to sign");
  if (c.sign) {
    const sig = new Uint8Array(await webcrypto.subtle.sign("Ed25519", keys.privateKey, Buffer.from(c.sign.messageB64, "base64")));
    const relayed = await api("POST", `/api/market/relay/${c.sign.id}`, { token: phone.token, body: { signatureB64: Buffer.from(sig).toString("base64") } });
    check(relayed.ok && relayed.order?.status === "paid", "phone-signed payment landed (key never left the device)", relayed.signature ?? relayed.message);
  }
  // Same device registers again: the oracle should see a duplicate identity.
  const dup = await api("POST", "/api/market/join", { body: { lat: spot.lat, lon: spot.lon, name: "Judge J. (again)", pubkey: null, identity: { deviceId, phone: "(404) 555-0199" } } }).catch((e) => ({ error: e.message }));
  if (dup.error) check(false, "second registration from the same device", dup.error);
  else {
    await until("a duplicate-identity case for the device", async () => {
      const cases = await api("GET", "/api/oracle/cases");
      return cases.find((k) => k.kind === "duplicate_identity" && k.subjects.some((s) => s.idx === phone.resident));
    }, { timeoutMs: 15_000 })
      .then((k) => check(true, `oracle caught the duplicate registration: "${k.title}"`))
      .catch((e) => check(false, "duplicate-identity case", e.message));
  }
}

// ---------- 7. counter QR charge ----------

const counterStore = (await api("POST", "/api/market/search", { token, body: { query: "batteries" } }))[0];
if (counterStore) {
  const charge = await api("POST", `/api/merchant/stores/${counterStore.store.idx}/charges`, { body: { lines: [{ itemId: counterStore.item.itemId, qty: 1 }] } });
  check(charge.status === "proposed" && charge.resident === null && charge.origin === "counter", `counter charge rung up at ${charge.storeName}: $${(charge.totalCents / 100).toFixed(2)}`);
  const pub2 = await api("GET", `/api/market/orders/${charge.id}`);
  check(pub2.id === charge.id, "charge readable by id (what the QR opens)");
  const paid = await api("POST", `/api/market/orders/${charge.id}/confirm`, { token, body: { payer: "resident" } });
  check(paid.order.status === "paid" && paid.order.resident === p0.resident, "resident paid the counter charge");
  const act = await api("GET", `/api/merchant/stores/${counterStore.store.idx}/activity?since=0`);
  check(act.events.some((e) => e.kind === "payment" && e.signature === paid.order.signature), "payment shows on the merchant terminal feed");
}

// ---------- 8. an outside agent over MCP ----------

if (!SKIP.has("mcp")) {
  const rpc = async (id, method, params) => {
    const res = await fetch(`${SERVER}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const text = await res.text();
    const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? "null");
    return { status: res.status, json };
  };
  try {
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rescu-e2e", version: "1.0" } });
    check(init.status === 200 && init.json?.result?.serverInfo, `MCP initialize: ${init.json?.result?.serverInfo?.name ?? init.status}`);
    const tools = await rpc(2, "tools/list", {});
    const names = tools.json?.result?.tools?.map((t) => t.name) ?? [];
    check(["get_wallet", "search_items", "propose_order", "confirm_order"].every((n) => names.includes(n)), `MCP tools: ${names.join(", ")}`);
    const call = await rpc(3, "tools/call", { name: "search_items", arguments: { query: "water", limit: 3 } });
    check(!call.json?.result?.isError && call.json?.result?.content?.[0]?.text, "MCP search_items returned offers", call.json?.result?.content?.[0]?.text?.slice(0, 120));
    const noAuth = await fetch(`${SERVER}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    check(noAuth.status === 401 || noAuth.status === 403, `MCP without a session is refused (${noAuth.status})`);
  } catch (err) {
    check(false, "MCP session", err.message);
  }
}

// ---------- 9. scorecard ----------

const metrics = await api("GET", "/api/oracle/metrics").catch(() => null);
if (metrics) log(`oracle: scans ${metrics.scans}, last ${metrics.lastScanMs} ms, precision ${metrics.precision}, recall ${metrics.recall}, planted ${JSON.stringify(metrics.planted)}, grok $${metrics.grok.spentUsd}`);
const health = await api("GET", "/health").catch(() => null);
if (health) log(`health: tiger rows ${health.tiger?.rows}, pending ${health.tiger?.pending}, grok spent $${health.grok?.spentUsd}`);

ws.close();
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
for (const f of failed) log("  FAILED:", f.what, f.detail);
process.exit(failed.length ? 1 : 0);
