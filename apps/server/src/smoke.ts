/**
 * End-to-end check of the people side on the local validator, no web app:
 *   persona -> Grok allowance -> order paid by the agent -> price hike -> store suspended ->
 *   the same order refused on-chain; a phone key joins ("I live here"), aid lands, it pays by
 *   signing on the "phone"; a frozen wallet is refused.
 *
 *   SIM_HOUSEHOLDS=1500 pnpm --filter @rescu/server smoke
 */
import { webcrypto } from "node:crypto";
import { base58Encode, base64ToBytes, bytesToBase64 } from "@rescu/live";
import { ChainRunner } from "./chain.js";
import { config, loadKeys } from "./config.js";
import type { PaymentEvent } from "./network/events.js";
import { Sim } from "./sim.js";
import { Tiger } from "./tiger.js";

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failed++;
  log(ok ? "PASS" : "FAIL", what);
};

const chain = new ChainRunner(loadKeys());
const tiger = new Tiger(config.tigerUrl);
tiger.start();
const sim = new Sim(chain, tiger);
const reason = await sim.health();
if (reason) throw new Error(reason);
sim.offline = null;

await sim.stage(config.defaultStorm, true);
const run = await sim.staged();
log(`staged ${run.world.households.n} households, ${run.world.merchants.n} stores`);
const events: PaymentEvent[] = [];
run.on("payment", (e) => {
  if (e.origin !== "sim") events.push(e);
});

const personas = run.people.personas();
check(personas.length === 6, `6 personas (${personas.map((p) => `${p.name} ${p.county}`).join("; ")})`);
const p0 = personas[0]!;
// Declare a little before the first persona's aid is due, at 12x so it lands quickly.
await sim.declare(p0.aidDueAt - 3600, 17_280, true);
log(`declared; fund ${run.fundSignature}`);

const session = run.people.claim(p0.resident);
const me = run.people.fromToken(session.token)!;
while (Number.isNaN(run.people.fundedAt(me))) await sleep(250);
let wallet = await run.people.wallet(me);
check(wallet.aid.landed && wallet.balanceCents === p0.aidCents, `persona aid landed: $${wallet.balanceCents / 100} in ${wallet.aid.timeToAidMs} ms`);
// Slow the clock so stores near home are open and the checks run at a stable sim time.
run.setSpeed(60);

const allowance = await run.people.setAllowance(me, 15_000);
check(allowance.wallet!.agent.approved && allowance.wallet!.agent.allowanceCents === 15_000, "agent allowance $150 on-chain");

const offers = run.market.search({ query: "water" }, run.clock.now(), { lat: me.lat, lon: me.lon });
check(offers.length > 0, `search water: ${offers.length} offers, nearest ${offers[0]?.store.name} ${offers[0]?.store.distanceKm} km`);
const offer = offers[0]!;
const order = await run.orders.propose(me, { store: offer.store.idx, lines: [{ itemId: offer.item.itemId, qty: 2 }], origin: "agent", note: "Water for 2 days" });
const paid = await run.orders.confirm(order.id, me);
check(paid.order.status === "paid" && !!paid.order.signature, `agent paid order ${paid.order.totalCents / 100} (${paid.order.status}, ${paid.order.latencyMs} ms)`);
wallet = await run.people.wallet(me);
check(wallet.agent.allowanceCents === 15_000 - order.totalCents, `allowance spent down to $${wallet.agent.allowanceCents / 100}`);

const before = run.market.price(offer.store.idx, offer.item.itemId, run.clock.now());
run.market.setPrice(offer.store.idx, offer.item.itemId, before * 4, run.clock.now());
const listing = run.market.listing(offer.store.idx, run.market.shelf(offer.store.idx).find((i) => i.id === offer.item.itemId)!, run.clock.now());
check(listing.priceCents === before * 4 && listing.preStormCents === offer.item.preStormCents, `price hike ${before} -> ${listing.priceCents}`);

const sus = await run.setStoreStatus(offer.store.idx, "suspended", "Price gouging on water");
check(sus.ok && run.market.status[offer.store.idx] === "suspended", `store suspended on-chain ${sus.signature}`);
const again = await run.orders.propose(me, { store: offer.store.idx, lines: [{ itemId: offer.item.itemId, qty: 1 }], origin: "shop" });
const refused = await run.orders.confirm(again.id, me, "resident");
check(refused.order.status === "rejected" && refused.order.rule === "MerchantSuspended", `next payment refused: ${refused.order.rule} (${refused.order.message})`);
check(!run.market.search({ query: "water" }, run.clock.now(), { lat: me.lat, lon: me.lon }).some((o) => o.store.idx === offer.store.idx), "suspended store gone from search");

// "I live here" with a key made the way a phone makes it (WebCrypto Ed25519).
const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
const pub = new Uint8Array(await webcrypto.subtle.exportKey("raw", keys.publicKey));
const spot = personas[1]!;
const el = run.people.eligibility(spot.lat, spot.lon);
check(el.eligible, `eligible at ${el.county}: $${el.aidCents / 100}`);
const far = run.people.eligibility(33.7756, -84.3963);
log(`Georgia Tech eligible=${far.eligible}: ${far.reason ?? ""} suggestion=${JSON.stringify(far.suggestion)}`);
const joined = await run.people.join({ lat: spot.lat, lon: spot.lon, name: "Judge J.", pubkey: base58Encode(pub), identity: { deviceId: "dev_smoketest_0001", phone: "(404) 555-0100" } });
const phone = run.people.fromToken(joined.token)!;
run.setSpeed(17_280);
while (Number.isNaN(run.people.fundedAt(phone))) await sleep(250);
run.setSpeed(60);
wallet = await run.people.wallet(phone);
check(wallet.custody === "device" && wallet.balanceCents === el.aidCents, `phone wallet funded $${wallet.balanceCents / 100} (time to aid ${wallet.aid.timeToAidMs} ms)`);
const near = run.market.search({ query: "bread" }, run.clock.now(), { lat: phone.lat, lon: phone.lon })[0]!;
const o2 = await run.orders.propose(phone, { store: near.store.idx, lines: [{ itemId: near.item.itemId, qty: 1 }], origin: "shop" });
const c2 = await run.orders.confirm(o2.id, phone, "resident");
check(!!c2.sign, "device custody gets a sign request");
const sig = new Uint8Array(await webcrypto.subtle.sign("Ed25519", keys.privateKey, base64ToBytes(c2.sign!.messageB64)));
const relayed = await run.people.relay(phone, c2.sign!.id, bytesToBase64(sig));
check(relayed.ok && relayed.order?.status === "paid", `phone-signed payment landed ${relayed.signature}`);

const frz = await run.setWalletFrozen(me.idx, true, "Duplicate registrations");
check(frz.ok, "wallet frozen on-chain");
const o3 = await run.orders.propose(me, { store: near.store.idx, lines: [{ itemId: near.item.itemId, qty: 1 }], origin: "shop" }).catch((e) => e);
if (o3 instanceof Error) check(false, `propose after freeze threw: ${o3.message}`);
else {
  const c3 = await run.orders.confirm(o3.id, me, "resident");
  check(c3.order.rule === "AccountFrozen", `frozen wallet refused: ${c3.order.rule}`);
}
wallet = await run.people.wallet(me);
check(wallet.frozen, "wallet view shows frozen (read from the chain)");

check(events.length >= 4, `payment events seen: ${events.map((e) => `${e.origin}:${e.ok ? "ok" : e.rule}`).join(", ")}`);
const acts = run.activity.page(offer.store.idx);
check(acts.events.some((e) => e.kind === "status"), `store activity: ${acts.events.map((e) => e.kind).join(", ")}`);
const batch = run.drainBatch();
log(`spotlight in last batch: ${batch?.spotlight.map((s) => s.label).join(" | ")}`);

log(failed ? `${failed} FAILED` : "all passed");
sim.stop();
await tiger.stop();
process.exit(failed ? 1 : 0);
