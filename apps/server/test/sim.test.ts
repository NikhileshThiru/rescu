import { describe, expect, it } from "vitest";
import { GENERATOR, ITEMS } from "../src/catalog.js";
import { ServerClock } from "../src/clock.js";
import { TimeHeap } from "../src/heap.js";
import { loadStormFile } from "../src/inputs.js";
import { Rng } from "../src/rng.js";
import { Households, type Order, PLAN, Shopper } from "../src/shopper.js";
import { buildWorld, CATEGORIES, NEAR_K, ROGUE, type TractInput } from "../src/world.js";

const HOUR = 3600;

/** Four counties of synthetic tracts around Helene's Big Bend landfall. */
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
        population: rng.int(1_000, 5_000),
        svi: rng.next(),
        need: c === 3 ? 0.01 : rng.range(0.1, 0.5),
      });
    }
  }
  return out;
}

const storm = loadStormFile("helene-2024");
const opts = { households: 3_000, merchantsMax: 200, seed: "test-seed" };

describe("world", () => {
  const w = buildWorld(storm, tracts(), opts);
  const H = w.households;

  it("samples households with their tract's exact aid, and the budget is their sum", () => {
    expect(H.n).toBe(3_000);
    let sum = 0;
    for (let h = 0; h < H.n; h++) {
      expect(H.aidCents[h]).toBeGreaterThan(0);
      sum += H.aidCents[h]!;
    }
    expect(w.budgetCents).toBe(sum);
    // The low-need county isn't declared, so nobody there is paid.
    expect(H.county.every((c) => c !== "12003")).toBe(true);
  });

  it("times aid inside the replay and remembers real nearby stores of each category", () => {
    for (let h = 0; h < H.n; h++) {
      expect(H.aidDue[h]).toBeGreaterThanOrEqual(w.domain.start - 3 * 86400);
      expect(H.aidDue[h]).toBeLessThan(w.domain.end);
      for (let c = 0; c < CATEGORIES.length; c++) {
        for (let j = 0; j < NEAR_K; j++) {
          const m = H.near[(h * CATEGORIES.length + c) * NEAR_K + j]!;
          if (m >= 0) expect(w.merchants.category[m]).toBe(CATEGORIES[c]);
        }
      }
    }
    expect(new Set(w.merchants.name).size).toBe(w.merchants.n);
  });

  it("is deterministic for a seed", () => {
    const again = buildWorld(storm, tracts(), opts);
    expect(again.budgetCents).toBe(w.budgetCents);
    expect([...again.households.rogue]).toEqual([...H.rogue]);
    expect(again.merchants.name).toEqual(w.merchants.name);
  });
});

describe("shopper", () => {
  const w = buildWorld(storm, tracts(), opts);
  const H = w.households;
  const s = new Households(H.n);
  const shopper = new Shopper(w, new Rng("shop"));
  const heap = new TimeHeap(H.n);
  const log: { t: number; o: Order }[][] = Array.from({ length: H.n }, () => []);
  for (let h = 0; h < H.n; h++) {
    shopper.funded(s, h, H.aidDue[h]!);
    heap.push(s.nextTrip[h]!, h);
  }
  // Every trip "confirms" instantly; rule-breaking orders are rejected the way the chain would.
  while (heap.size) {
    const [t, h] = heap.pop();
    if (t !== s.nextTrip[h]) continue;
    const trip = shopper.trip(s, h, t);
    if (trip.kind === "stop") continue;
    if (trip.kind === "orders") {
      trip.orders.forEach((o, i) => {
        log[h]!.push({ t, o });
        const rejected = o.rogue === ROGUE.generator || o.rogue === ROGUE.resale || o.rogue === ROGUE.unregistered || (o.rogue === ROGUE.spree && i === 2);
        if (!rejected) {
          s.spent[h]! += o.amountCents;
          s.record(h, t, o.amountCents);
        }
      });
    }
    s.nextTrip[h] = trip.next;
    heap.push(trip.next, h);
  }

  it("never lets an honest order near the chain's caps, even with 5 h of clock slop", () => {
    let orders = 0;
    for (let h = 0; h < H.n; h++) {
      const legit = log[h]!.filter((x) => x.o.rogue === 0);
      for (const { t, o } of legit) {
        orders++;
        expect(o.amountCents).toBeLessThanOrEqual(PLAN.orderCapCents);
        expect(o.amountCents).toBe(o.lines.reduce((a, l) => a + l.qty * l.cents, 0));
        const inWindow = legit.filter((x) => x.t > t - 29 * HOUR && x.t <= t).reduce((a, x) => a + x.o.amountCents, 0);
        expect(inWindow).toBeLessThanOrEqual(30_000);
        for (const l of o.lines) expect(ITEMS[l.id]!.sells).toContain(w.merchants.category[o.merchant]);
      }
      expect(s.spent[h]).toBeLessThanOrEqual(H.aidCents[h]!);
    }
    // ~7 trips per household over 30 days.
    expect(orders / H.n).toBeGreaterThan(3);
  });

  it("stops shopping before aid expires", () => {
    for (const orders of log) for (const { t } of orders) expect(t).toBeLessThanOrEqual(w.domain.end - 12 * HOUR);
  });

  it("rule-breakers try exactly what the chain blocks", () => {
    let tried = 0;
    for (let h = 0; h < H.n; h++) {
      for (const [i, { o }] of log[h]!.filter((x) => x.o.rogue).entries()) {
        tried++;
        if (o.rogue === ROGUE.generator) expect(o.amountCents).toBe(GENERATOR.cents);
        if (o.rogue === ROGUE.resale) expect(o.resaleTo).not.toBe(h);
        if (o.rogue === ROGUE.unregistered) expect(o.rogueStore).toBeGreaterThanOrEqual(0);
        if (o.rogue === ROGUE.spree && i === 2) {
          const three = log[h]!.filter((x) => x.o.rogue === ROGUE.spree).map((x) => x.o.amountCents);
          expect(three[0]! + three[1]!).toBeLessThanOrEqual(30_000);
          expect(three[0]! + three[1]! + three[2]!).toBeGreaterThan(30_000);
          for (const c of three) expect(c).toBeLessThanOrEqual(20_000);
        }
      }
    }
    expect(tried).toBeGreaterThan(0);
  });
});

describe("heap + clock", () => {
  it("pops in time order", () => {
    const rng = new Rng("heap");
    const heap = new TimeHeap(4);
    const keys = Array.from({ length: 1_000 }, () => rng.range(0, 1e6));
    keys.forEach((k, i) => heap.push(k, i));
    const out: number[] = [];
    while (heap.size) out.push(heap.pop()[0]);
    expect(out).toEqual([...keys].sort((a, b) => a - b));
  });

  it("knows when it passed a sim time, never before the last change", () => {
    const c = new ServerClock(1_000, 100_000, 3_600);
    c.set(10_000, 3_600, true);
    const anchor = c.lastChangeMs;
    expect(c.wallTimeOf(9_000)).toBe(anchor);
    expect(c.wallTimeOf(1e9)).toBeGreaterThanOrEqual(anchor);
    c.seek(1e9);
    expect(c.now()).toBe(100_000);
  });
});
