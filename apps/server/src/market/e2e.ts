/**
 * End-to-end check of the Relief Market against a RUNNING sim server (REST + MCP + optionally one
 * real Grok turn), the way the phone and outside agents use it:
 *
 *   npx tsx src/market/e2e.ts http://localhost:4200 [--grok] [--no-declare]
 *
 * Declares the staged run a little before the first persona's aid is due (unless it's live).
 */
import { webcrypto } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type AllowanceResult,
  base58Encode,
  base64ToBytes,
  bytesToBase64,
  type ChatResult,
  type ConfirmResult,
  type Eligibility,
  type Offer,
  type Order,
  type Persona,
  type RelayResult,
  type RunInfo,
  type Session,
  type WalletView,
  WS_PATH,
} from "@rescu/live";
import WebSocket from "ws";

const base = (process.argv[2] ?? "http://localhost:4200").replace(/\/$/, "");
const withGrok = process.argv.includes("--grok");
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failed++;
  log(ok ? "PASS" : "FAIL", what);
};

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}
async function ok<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const r = await call<T>(method, path, body, token);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

function send(msg: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}${WS_PATH}`);
    ws.on("open", () => {
      ws.send(JSON.stringify(msg));
      setTimeout(() => {
        ws.close();
        resolve();
      }, 300);
    });
    ws.on("error", reject);
  });
}

let run = await ok<RunInfo>("GET", "/run");
while (run.phase === "staging" || run.phase === "offline") {
  await sleep(1000);
  run = await ok<RunInfo>("GET", "/run");
}
log(`run ${run.id} ${run.stormName} ${run.phase}`);
const personas = await ok<Persona[]>("GET", "/api/market/personas");
check(personas.length === 6, `personas: ${personas.map((p) => `${p.name} (${p.county}, $${p.aidCents / 100})`).join("; ")}`);
const p0 = personas.find((p) => !p.claimed) ?? personas[0]!;
if (run.phase === "ready" && !process.argv.includes("--no-declare")) {
  await send({ type: "declare", t: p0.aidDueAt - 2 * 3600, speed: 17_280, playing: true });
  log("declared");
}

const session = await ok<Session>("POST", `/api/market/personas/${p0.resident}/claim`);
check(!!session.token && session.custody === "server", `claimed ${p0.name}`);
const unauth = await call("GET", "/api/market/wallet", undefined, "nope");
check(unauth.status === 401, "bad token -> 401");
let wallet = await ok<WalletView>("GET", "/api/market/wallet", undefined, session.token);
while (!wallet.aid.landed) {
  await sleep(500);
  wallet = await ok<WalletView>("GET", "/api/market/wallet", undefined, session.token);
}
check(wallet.balanceCents === p0.aidCents, `aid landed $${wallet.balanceCents / 100} (time to aid ${wallet.aid.timeToAidMs} ms)`);
await send({ type: "speed", speed: 1440 });

const allowance = await ok<AllowanceResult>("POST", "/api/market/agent/allowance", { allowanceCents: 15_000 }, session.token);
check(allowance.wallet?.agent.allowanceCents === 15_000, `allowance $150 on-chain ${allowance.wallet?.agent.signature}`);

const offers = await ok<Offer[]>("POST", "/api/market/search", { query: "water" }, session.token);
check(offers.length > 0 && offers.every((o) => (o.store.distanceKm ?? 0) <= 150), `search water: ${offers.length} offers, nearest ${offers[0]?.store.name} ${offers[0]?.store.distanceKm} km`);
const stores = await ok<unknown[]>("POST", "/api/market/stores", {}, session.token);
check(stores.length > 0, `stores: ${stores.length}`);
const badBody = await call("POST", "/api/market/search", { limit: 999 }, session.token);
check(badBody.status === 400, `zod rejects a bad body (${JSON.stringify(badBody.data)})`);
const o = offers[0]!;
const order = await ok<Order>("POST", "/api/market/orders", { store: o.store.idx, lines: [{ itemId: o.item.itemId, qty: 2 }], origin: "agent", note: "Water for 2 days" }, session.token);
check(order.status === "proposed" && order.origin === "agent", `proposed ${order.id} $${order.totalCents / 100}`);
const pub = await ok<Order>("GET", `/api/market/orders/${order.id}`);
check(pub.id === order.id, "order is public by id");
const paid = await ok<ConfirmResult>("POST", `/api/market/orders/${order.id}/confirm`, { payer: "agent" }, session.token);
check(paid.order.status === "paid" && !!paid.order.signature, `agent paid in ${paid.order.latencyMs} ms: ${paid.order.signature}`);
const again = await call("POST", `/api/market/orders/${order.id}/confirm`, { payer: "agent" }, session.token);
check(again.status === 409, "double confirm -> 409");
const mine = await ok<Order[]>("GET", "/api/market/orders", undefined, session.token);
check(mine[0]?.id === order.id, `orders list: ${mine.length}`);
const cancelMe = await ok<Order>("POST", "/api/market/orders", { store: o.store.idx, lines: [{ itemId: o.item.itemId, qty: 1 }] }, session.token);
const cancelled = await ok<Order>("POST", `/api/market/orders/${cancelMe.id}/cancel`, undefined, session.token);
check(cancelled.status === "cancelled", "cancel");
const detail = await ok<{ listings: unknown[]; distanceKm: number | null }>("GET", `/api/market/stores/${o.store.idx}`, undefined, session.token);
check(detail.listings.length > 0 && detail.distanceKm !== null, `store detail: ${detail.listings.length} listings`);
const cat = await ok<unknown[]>("GET", "/api/market/catalog");
check(cat.length > 40, `catalog ${cat.length} items`);

// ---- "I live here" with a phone key ----
const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey));
const spot = personas[1]!;
const el = await ok<Eligibility>("GET", `/api/market/eligibility?lat=${spot.lat}&lon=${spot.lon}`);
check(el.eligible, `eligible in ${el.county}: $${el.aidCents / 100}`);
const far = await ok<Eligibility>("GET", "/api/market/eligibility?lat=33.7756&lon=-84.3963");
check(!far.eligible && !!far.suggestion, `Atlanta: ${far.reason}`);
const joined = await ok<Session>("POST", "/api/market/join", { lat: spot.lat, lon: spot.lon, name: "E2E Judge", pubkey: base58Encode(raw), identity: { deviceId: `dev_e2e_${Date.now()}` } });
check(joined.custody === "device", "joined with a device key");
await send({ type: "speed", speed: 17_280 });
let pw = await ok<WalletView>("GET", "/api/market/wallet", undefined, joined.token);
while (!pw.aid.landed) {
  await sleep(500);
  pw = await ok<WalletView>("GET", "/api/market/wallet", undefined, joined.token);
}
await send({ type: "speed", speed: 1440 });
check(pw.balanceCents === el.aidCents, `phone aid landed $${pw.balanceCents / 100} (time to aid ${pw.aid.timeToAidMs} ms)`);
const near = (await ok<Offer[]>("POST", "/api/market/search", { query: "bread" }, joined.token))[0]!;
const o2 = await ok<Order>("POST", "/api/market/orders", { store: near.store.idx, lines: [{ itemId: near.item.itemId, qty: 1 }] }, joined.token);
const c2 = await ok<ConfirmResult>("POST", `/api/market/orders/${o2.id}/confirm`, { payer: "resident" }, joined.token);
check(!!c2.sign && c2.order.status === "paying", "device custody gets a sign request");
const sig = new Uint8Array(await webcrypto.subtle.sign("Ed25519", keys.privateKey, base64ToBytes(c2.sign!.messageB64)));
const relayed = await ok<RelayResult>("POST", `/api/market/relay/${c2.sign!.id}`, { signatureB64: bytesToBase64(sig) }, joined.token);
check(relayed.ok && relayed.order?.status === "paid", `phone-signed payment landed ${relayed.signature}`);
const ap = await ok<AllowanceResult>("POST", "/api/market/agent/allowance", { allowanceCents: 5_000 }, joined.token);
const apSig = new Uint8Array(await webcrypto.subtle.sign("Ed25519", keys.privateKey, base64ToBytes(ap.sign!.messageB64)));
const apDone = await ok<RelayResult>("POST", `/api/market/relay/${ap.sign!.id}`, { signatureB64: bytesToBase64(apSig) }, joined.token);
check(apDone.ok && apDone.wallet?.agent.allowanceCents === 5_000, "phone granted the agent $50 (signed on the phone)");

// ---- MCP ----
const mcp = new Client({ name: "rescu-e2e", version: "0.0.1" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${session.token}` } } }));
const tools = await mcp.listTools();
check(tools.tools.length === 7, `MCP tools: ${tools.tools.map((t) => t.name).join(", ")}`);
const text = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);
const found = text(await mcp.callTool({ name: "search_items", arguments: { query: "batteries", limit: 5 } }));
check(found.stores?.length > 0, `MCP search_items: ${found.stores?.[0]?.name} ${JSON.stringify(found.stores?.[0]?.items?.[0])}`);
const first = found.stores[0];
const prop = text(await mcp.callTool({ name: "propose_order", arguments: { store: first.store, lines: [{ itemId: first.items[0][0], qty: 1 }], note: "MCP test" } }));
check(!!prop.orderId, `MCP propose_order ${prop.orderId} ${prop.total}`);
const conf = text(await mcp.callTool({ name: "confirm_order", arguments: { orderId: prop.orderId } }));
check(conf.status === "paid", `MCP confirm_order: ${conf.status} ${conf.signature ?? conf.rule}`);
const bad = await mcp.callTool({ name: "get_store", arguments: { store: 999_999 } });
check(bad.isError === true, `MCP errors come back as tool errors: ${text(bad).error}`);
const wal = text(await mcp.callTool({ name: "get_wallet", arguments: {} }));
check(!!wal.balance, `MCP get_wallet: ${wal.balance}, allowance ${wal.agentAllowance}`);
await mcp.close();
const noAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
check(noAuth.status === 401, "MCP without a token -> 401");
const get = await fetch(`${base}/mcp`);
check(get.status === 405, "GET /mcp -> 405");

// ---- Grok ----
if (withGrok) {
  const t = Date.now();
  const chat = await ok<ChatResult>("POST", "/api/market/agent/chat", { messages: [{ role: "user", content: p0.prompts[0] ?? "We're out of water and food" }] }, session.token);
  log(`Grok (${chat.model}, fallback=${chat.fallback}) ${Date.now() - t} ms, ${chat.usage.inputTokens}+${chat.usage.outputTokens} tokens, $${chat.usage.usd}`);
  log(`  tools: ${chat.tools.map((x) => x.summary).join(" | ")}`);
  log(`  reply: ${chat.reply}`);
  check(chat.orders.length > 0, `Grok proposed ${chat.orders.map((x) => `${x.storeName} $${x.totalCents / 100} (${x.lines.map((l) => `${l.qty}x ${l.name}`).join(", ")})`).join("; ")}`);
  if (chat.orders[0]) {
    const c = await ok<ConfirmResult>("POST", `/api/market/orders/${chat.orders[0].id}/confirm`, { payer: "agent" }, session.token);
    check(c.order.status === "paid", `resident confirmed Grok's order: ${c.order.status} ${c.order.signature ?? c.order.rule}`);
  }
}

log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
