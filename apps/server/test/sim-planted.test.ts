import { describe, expect, it } from "vitest";
import { ALL_ITEMS } from "../src/catalog.js";
import { TimeHeap } from "../src/heap.js";
import { loadStormFile } from "../src/inputs.js";
import { Market } from "../src/network/market.js";
import { Rng } from "../src/rng.js";
import { CHAIN_CAPS, Households, type Order, PLAN, Shopper } from "../src/shopper.js";
import { buildWorld, FRAUD, PLANT, plantedStores, ROGUE, type TractInput, type World } from "../src/world.js";

const HOUR = 3600;

/** Four counties of synthetic tracts around Helene's Big Bend landfall (same shape as sim.test.ts). */
function tracts(): TractInput[] {
  const rng = new Rng("tracts");
  const out: TractInput[] = [];
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 60; i++) {
      out.push({
        geoid: `12${String(c).padStart(3, "0")}${String(i).padStart(6, "0")}`,
        countyFips: `12${String(c).padStart(3, "0")}`,
        countyName: `Test ${c} County`,
        state: "FL",
        lat: 30.1 + c * 0.35 + rng.range(0, 0.3),
        lon: -84 + rng.range(0, 1.2),
        households: rng.int(400, 2_000),
        population: rng.int(10_000, 40_000),
        svi: rng.next(),
        need: c === 3 ? 0.01 : rng.range(0.1, 0.5),
      });
    }
  }
  return out;
}

const storm = loadStormFile("helene-2024");
const opts = { households: 6_000, merchantsMax: 400, seed: "test-seed" };

describe("planted bad actors", () => {
  const w = buildWorld(storm, tracts(), opts);
  const H = w.households;
  const M = w.merchants;
  const byKind = (k: string) => w.planted.filter((p) => p.kind === k);

  it("plants ~2% gougers and ~1% fraud households in the right mix", () => {
    const gougers = byKind("gouging");
    expect(M.n).toBeGreaterThan(100);
    expect(gougers.length).toBe(Math.max(1, Math.round(M.n * PLANT.gougeShare)));
    let fraud = 0;
    const kinds = [0, 0, 0, 0];
    for (let h = 0; h < H.n; h++) {
      if (H.fraud[h]) fraud++;
      kinds[H.fraud[h]!]!++;
    }
    expect(fraud).toBeGreaterThanOrEqual(Math.round(H.n * 0.008));
    expect(fraud).toBeLessThanOrEqual(Math.round(H.n * PLANT.fraudShare) + 2);
    // ~40% duplicates, ~35% collusion, ~25% velocity.
    expect(kinds[FRAUD.duplicate]! / fraud).toBeGreaterThan(0.3);
    expect(kinds[FRAUD.collusion]! / fraud).toBeGreaterThan(0.25);
    expect(kinds[FRAUD.velocity]! / fraud).toBeGreaterThan(0.15);
    for (const g of gougers) {
      const m = g.merchants[0]!;
      expect(M.gouge[m]).toBeGreaterThanOrEqual(PLANT.gougeMin);
      expect(M.gouge[m]).toBeLessThanOrEqual(PLANT.gougeMax);
      const arrive = w.aidDueAt(M.h3[m]!);
      expect(M.gougeFrom[m]! - arrive).toBeGreaterThanOrEqual(6 * HOUR - 1);
      expect(M.gougeFrom[m]! - arrive).toBeLessThanOrEqual(30 * HOUR + 1);
    }
  });

  it("keeps fraud, rule-breakers, gougers and colluding stores apart", () => {
    const seen = new Set<number>();
    for (const p of w.planted) {
      for (const h of p.residents) {
        expect(seen.has(h)).toBe(false);
        seen.add(h);
        expect(H.rogue[h]).toBe(ROGUE.none);
      }
    }
    for (let h = 0; h < H.n; h++) {
      if (H.fraud[h]) expect(H.rogue[h]).toBe(ROGUE.none);
      expect(H.colludeWith[h]! >= 0).toBe(H.fraud[h] === FRAUD.collusion);
    }
    const gougeStores = new Set(byKind("gouging").flatMap((p) => p.merchants));
    const collStores = new Set(byKind("collusion").flatMap((p) => p.merchants));
    for (const m of collStores) {
      expect(gougeStores.has(m)).toBe(false);
      expect(["grocery", "general"]).toContain(M.category[m]);
    }
    for (let m = 0; m < M.n; m++) expect(M.gouge[m] !== 1).toBe(gougeStores.has(m));
    expect(plantedStores(w).size).toBe(gougeStores.size + collStores.size);
    for (const p of byKind("collusion")) {
      expect(p.residents.length).toBeGreaterThanOrEqual(3);
      for (const h of p.residents) expect(H.colludeWith[h]).toBe(p.merchants[0]);
    }
  });

  it("duplicate clusters share one identity (device, mostly phone and address) in one county", () => {
    const clusters = byKind("duplicate_identity");
    expect(clusters.length).toBeGreaterThan(0);
    let phones = 0;
    let pairs = 0;
    for (const c of clusters) {
      expect(c.residents.length).toBeGreaterThanOrEqual(3);
      expect(c.residents.length).toBeLessThanOrEqual(5);
      const [first, ...rest] = c.residents;
      for (const h of rest) {
        expect(H.device[h]).toBe(H.device[first!]);
        expect(H.county[h]).toBe(H.county[first!]);
        pairs++;
        if (H.phone[h] === H.phone[first!]) phones++;
      }
    }
    expect(phones / pairs).toBeGreaterThan(0.4);
    // Honest households never share a device or phone with anyone.
    const devices = new Map<string, number>();
    for (let h = 0; h < H.n; h++) devices.set(H.device[h]!, (devices.get(H.device[h]!) ?? 0) + 1);
    for (let h = 0; h < H.n; h++) if (H.fraud[h] !== FRAUD.duplicate) expect(devices.get(H.device[h]!)).toBe(1);
  });

  it("is deterministic and leaves the honest world where it was", () => {
    const again = buildWorld(storm, tracts(), opts);
    expect(again.planted).toEqual(w.planted);
    expect([...again.households.fraud]).toEqual([...H.fraud]);
    expect([...again.merchants.gougeFrom]).toEqual([...M.gougeFrom]);
    expect(again.households.device).toEqual(H.device);
  });
});

/**
 * The shopper over the real Market (prices, markups, stock), with the chain emulated: $200 per
 * order, $300 per rolling 24 h. Every order "confirms" instantly.
 */
function simulate(w: World) {
  const H = w.households;
  const market = new Market(w, () => "", "test");
  const s = new Households(H.n);
  const shopper = new Shopper(w, new Rng("shop"), {
    price: (m, i, t) => market.price(m, i, t),
    stock: (m, i, t) => market.stock(m, i, t),
    approved: (m) => market.status[m] === "approved",
  });
  const heap = new TimeHeap(H.n);
  const log: { t: number; o: Order; ok: boolean }[] = [];
  for (let h = 0; h < H.n; h++) {
    shopper.funded(s, h, H.aidDue[h]!);
    heap.push(s.nextTrip[h]!, h);
  }
  while (heap.size) {
    const [t, h] = heap.pop();
    if (t !== s.nextTrip[h]) continue;
    const trip = shopper.trip(s, h, t);
    if (trip.kind === "stop") continue;
    if (trip.kind === "orders") {
      trip.orders.forEach((o, i) => {
        const overDaily = o.merchant >= 0 && s.windowOver(h, t, CHAIN_CAPS.windowSecs).cents + o.amountCents > CHAIN_CAPS.windowCents;
        const ok = !(o.rogue && o.rogue !== ROGUE.spree) && !(o.rogue === ROGUE.spree && i === 2) && !overDaily && o.amountCents <= CHAIN_CAPS.orderCents;
        if (overDaily) s.bounced[h] = 1;
        if (ok) {
          s.spent[h]! += o.amountCents;
          s.record(h, t, o.amountCents);
          market.recordSale(o.merchant, o.lines.map((l) => ({ itemId: l.id, qty: l.qty })), o.amountCents, t);
        }
        log.push({ t, o, ok });
      });
    }
    s.nextTrip[h] = trip.next;
    heap.push(trip.next, h);
  }
  return { log, s, market };
}

describe("planted behaviour", () => {
  const w = buildWorld(storm, tracts(), opts);
  const H = w.households;
  const M = w.merchants;
  const { log, s, market } = simulate(w);

  it("shoppers pay a gouger's marked-up prices once the markup starts", () => {
    let marked = 0;
    for (const { t, o, ok } of log) {
      if (!ok || o.merchant < 0 || M.gouge[o.merchant] === 1) continue;
      for (const l of o.lines) {
        expect(l.cents).toBe(market.price(o.merchant, l.id, t));
        if (t >= M.gougeFrom[o.merchant]! && market.gougeAt(o.merchant, l.id, t) !== 1) {
          expect(l.cents).toBeGreaterThan(market.preStorm(o.merchant, l.id) * 1.8);
          marked++;
        }
      }
    }
    expect(marked).toBeGreaterThan(0);
  });

  it("colluders put most of their aid through their one store, never tripping a cap", () => {
    const colluders = w.planted.filter((p) => p.kind === "collusion").flatMap((p) => p.residents);
    expect(colluders.length).toBeGreaterThan(0);
    for (const h of colluders) {
      const mine = log.filter((x) => x.o.household === h);
      expect(mine.every((x) => x.ok && x.o.merchant === H.colludeWith[h])).toBe(true);
      expect(s.spent[h]! / H.aidCents[h]!).toBeGreaterThan(0.8);
      for (const x of mine) expect(x.o.amountCents).toBeLessThanOrEqual(PLAN.orderCapCents);
      // The first "purchase" comes 6-24 h after the aid.
      expect(mine[0]!.t - H.aidDue[h]!).toBeGreaterThanOrEqual(6 * HOUR - 1);
      expect(mine[0]!.t - H.aidDue[h]!).toBeLessThanOrEqual(24 * HOUR + 1);
    }
  });

  it("velocity households drain their grant at the cap and bounce off it", () => {
    const fast = w.planted.filter((p) => p.kind === "velocity").map((p) => p.residents[0]!);
    expect(fast.length).toBeGreaterThan(0);
    let bounces = 0;
    for (const h of fast) {
      const mine = log.filter((x) => x.o.household === h);
      bounces += mine.filter((x) => !x.ok).length;
      expect(s.spent[h]! / H.aidCents[h]!).toBeGreaterThan(0.9);
      const landed = mine.filter((x) => x.ok);
      // Spent as fast as the cap allows: $300 a day.
      const days = (landed[landed.length - 1]!.t - landed[0]!.t) / 86_400;
      expect(days).toBeLessThanOrEqual(H.aidCents[h]! / 30_000 + 1.5);
    }
    expect(bounces).toBeGreaterThanOrEqual(fast.length);
  });

  it("honest households never bounce off a cap", () => {
    const honest = log.filter((x) => !x.o.rogue && !x.o.fraud);
    expect(honest.length).toBeGreaterThan(H.n * 3);
    expect(honest.every((x) => x.ok)).toBe(true);
  });

  it("nobody shops at a suspended store", () => {
    const w2 = buildWorld(storm, tracts(), opts);
    const market2 = new Market(w2, () => "", "test");
    const busiest = [...market.payments.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    market2.setStatus(busiest, "suspended");
    const shopper = new Shopper(w2, new Rng("shop"), {
      price: (m, i, t) => market2.price(m, i, t),
      stock: () => 100,
      approved: (m) => market2.status[m] === "approved",
    });
    const s2 = new Households(w2.households.n);
    let trips = 0;
    for (let h = 0; h < w2.households.n; h++) {
      shopper.funded(s2, h, w2.households.aidDue[h]!);
      const trip = shopper.trip(s2, h, s2.nextTrip[h]!);
      if (trip.kind !== "orders") continue;
      trips++;
      for (const o of trip.orders) expect(o.merchant).not.toBe(busiest);
    }
    expect(trips).toBeGreaterThan(100);
    expect(ALL_ITEMS.length).toBeGreaterThan(40);
  });
});
