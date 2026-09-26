import type { Listing, MarketToolName, Offer, Order, ProposeOrderInput, SearchItemsInput, StoreSummary, WalletView } from "@rescu/live";
import { describe, expect, it } from "vitest";
import { Agent, GROK_TOOLS, type GrokLike } from "../src/agent/agent.js";
import type { AgentEnv } from "../src/agent/env.js";
import { needsFrom, plan } from "../src/agent/planner.js";
import { RateLimiter } from "../src/agent/ratelimit.js";
import { ITEMS } from "../src/catalog.js";
import { GrokUnavailable, type GrokMessage, type GrokResult } from "../src/grok.js";
import { ApiFail } from "../src/network/errors.js";

// ---------- a tiny fake market: two stores near home ----------

function store(idx: number, name: string, category: StoreSummary["category"], km: number): StoreSummary {
  return { idx, owner: `owner${idx}`, name, category, county: "Lowndes, GA", lat: 30.8, lon: -83.3, h3: "85", status: "approved", flagged: false, open: true, reopensAt: null, distanceKm: km };
}
const GROCERY = store(3, "Riverside Grocery", "grocery", 2.4);
const PHARMACY = store(7, "Oak Street Pharmacy", "pharmacy", 4.1);
const STORES = [GROCERY, PHARMACY];

function listing(itemId: number, price?: number): Listing {
  const i = ITEMS[itemId]!;
  return { itemId, name: i.name, need: i.need, priceCents: price ?? i.cents, preStormCents: i.cents, stock: 50, maxQty: i.maxQty };
}

function fakeEnv(opts: { wallet?: Partial<WalletView>; household?: Partial<AgentEnv["resident"]> } = {}) {
  const proposed: Order[] = [];
  const toolCalls: { name: string; args: unknown }[] = [];
  const shelf = (s: StoreSummary) => ITEMS.filter((i) => i.sells.includes(s.category)).map((i) => listing(i.id));
  const search = (input: SearchItemsInput): Offer[] => {
    const out: Offer[] = [];
    for (const s of STORES)
      for (const l of shelf(s)) {
        if (input.need && l.need !== input.need) continue;
        if (input.query && !l.name.toLowerCase().includes(input.query.toLowerCase().replace(/s$/, ""))) continue;
        out.push({ store: s, item: l });
      }
    return out.slice(0, input.limit ?? 8);
  };
  const propose = async (input: ProposeOrderInput): Promise<Order> => {
    const s = STORES.find((x) => x.idx === input.store);
    if (!s) throw new ApiFail(404, "not_found", `No store ${input.store}`);
    const lines = input.lines.map((l) => {
      const it = shelf(s).find((x) => x.itemId === l.itemId);
      if (!it) throw new ApiFail(409, "not_carried", `${s.name} doesn't carry item ${l.itemId}`);
      return { itemId: l.itemId, name: it.name, qty: l.qty, unitCents: it.priceCents };
    });
    const total = lines.reduce((a, l) => a + l.qty * l.unitCents, 0);
    if (total > 20_000) throw new ApiFail(409, "over_order_cap", "over the cap");
    const o = {
      id: `o_${proposed.length + 1}`,
      runId: "r",
      resident: 1,
      residentName: "Maria",
      store: s.idx,
      storeName: s.name,
      category: s.category,
      lines,
      totalCents: total,
      origin: "agent",
      payer: "agent",
      status: "proposed",
      createdAt: 0,
      simT: 0,
      pickup: { name: s.name, county: s.county, lat: s.lat, lon: s.lon, distanceKm: s.distanceKm },
      home: [-83.3, 30.8],
      note: input.note ?? null,
      signature: null,
      rule: null,
      message: null,
      latencyMs: null,
      paidAt: null,
    } satisfies Order;
    proposed.push(o);
    return o;
  };
  const wallet: WalletView = {
    runId: "r",
    resident: 1,
    owner: "x",
    name: "Maria",
    custody: "server",
    home: { lat: 30.8, lon: -83.3, county: "Lowndes, GA", h3: "85" },
    household: { size: 4, kids: true, pet: false },
    aid: { cents: 200_000, landed: true, dueAt: 0, landedAt: 0, signature: "sig", timeToAidMs: 800 },
    balanceCents: 200_000,
    spentCents: 0,
    window: { spentCents: 0, capCents: 30_000, remainingCents: 30_000, perOrderCapCents: 20_000 },
    agent: { approved: true, allowanceCents: 15_000, signature: null },
    frozen: false,
    flagged: false,
    expiresAt: 0,
    simNow: 0,
    ...opts.wallet,
  };
  const env: AgentEnv = {
    resident: { idx: 1, name: "Maria", county: "Lowndes, GA", size: 4, kids: true, pet: false, ...opts.household },
    stormName: "Helene",
    today: () => "Fri, Sep 27, 2:00 AM",
    wallet: async () => wallet,
    search,
    propose,
    tool: async (name: MarketToolName, args: unknown) => {
      toolCalls.push({ name, args });
      if (name === "search_items") return { result: search(args as SearchItemsInput), summary: "searched" };
      if (name === "propose_order") {
        const o = await propose(args as ProposeOrderInput);
        return { result: { orderId: o.id }, summary: `Proposed at ${o.storeName}`, order: o };
      }
      if (name === "get_wallet") return { result: { balance: "$2000.00" }, summary: "wallet" };
      return { result: [], summary: name };
    },
    order: (id) => proposed.find((o) => o.id === id),
  };
  return { env, proposed, toolCalls };
}

// ---------- a scripted Grok ----------

function result(message: GrokMessage, usd = 0.001): GrokResult {
  return { message, finishReason: message.tool_calls ? "tool_calls" : "stop", usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 50, usd }, model: "grok-fake", ms: 5 };
}

class FakeGrok implements GrokLike {
  readonly models = { agent: "grok-fake", oracle: "grok-fake" };
  readonly requests: { messages: GrokMessage[]; toolChoice?: string; tools?: unknown[] }[] = [];
  constructor(private readonly script: (GrokMessage | Error)[]) {}
  async chat(req: { messages: GrokMessage[]; toolChoice?: "auto" | "none" | "required"; tools?: unknown[] }): Promise<GrokResult> {
    this.requests.push({ messages: structuredClone(req.messages), toolChoice: req.toolChoice, tools: req.tools });
    const next = this.script.shift();
    if (!next) throw new GrokUnavailable("api_error", "script ran out");
    if (next instanceof Error) throw next;
    return result(next);
  }
}

const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

describe("Grok agent", () => {
  it("runs the tool loop: search, propose, reply, and returns the proposed order", async () => {
    const { env, toolCalls } = fakeEnv();
    const grok = new FakeGrok([
      { role: "assistant", content: null, tool_calls: [call("c1", "search_items", { need: "water" })] },
      { role: "assistant", content: null, tool_calls: [call("c2", "propose_order", { store: 3, lines: [{ itemId: 0, qty: 2 }], note: "Water for 4" })] },
      { role: "assistant", content: "I put together 2 cases of water at Riverside Grocery, 2.4 km away, $11.98. Tap Confirm to pay." },
    ]);
    const res = await new Agent(grok).chat(env, { messages: [{ role: "user", content: "We're out of water" }] });
    expect(res.fallback).toBe(false);
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0]!.storeName).toBe("Riverside Grocery");
    expect(res.reply).toContain("Riverside");
    expect(res.tools.map((t) => t.name)).toEqual(["search_items", "propose_order"]);
    expect(toolCalls.map((t) => t.name)).toEqual(["search_items", "propose_order"]);
    expect(res.usage.inputTokens).toBe(3000);
    expect(res.usage.usd).toBeCloseTo(0.003, 6);
    // The tool results went back to the model with the right ids.
    const third = grok.requests[2]!.messages;
    expect(third.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    // The system prompt carries the household and the wallet's limits.
    const sys = grok.requests[0]!.messages[0]!.content!;
    expect(sys).toContain("Maria");
    expect(sys).toContain("4 people");
    expect(sys).toContain("$300.00 left");
  });

  it("never offers confirm_order to Grok and refuses it if called anyway", async () => {
    expect(GROK_TOOLS.map((t) => t.function.name)).not.toContain("confirm_order");
    expect(GROK_TOOLS.find((t) => t.function.name === "search_items")!.function.parameters).toHaveProperty("properties.need");
    const { env, toolCalls } = fakeEnv();
    const grok = new FakeGrok([
      { role: "assistant", content: null, tool_calls: [call("c1", "confirm_order", { orderId: "o_1" })] },
      { role: "assistant", content: "Please tap Confirm in the app." },
    ]);
    const res = await new Agent(grok).chat(env, { messages: [{ role: "user", content: "just pay it" }] });
    expect(toolCalls).toHaveLength(0);
    expect(JSON.parse(grok.requests[1]!.messages.at(-1)!.content!)).toMatchObject({ code: "not_allowed" });
    expect(res.orders).toHaveLength(0);
  });

  it("returns tool errors to the model as data and caps proposals at 2 per turn", async () => {
    const { env, proposed } = fakeEnv();
    const p = (id: string) => call(id, "propose_order", { store: 3, lines: [{ itemId: 0, qty: 1 }] });
    const grok = new FakeGrok([
      { role: "assistant", content: null, tool_calls: [call("bad", "propose_order", { store: 99, lines: [{ itemId: 0, qty: 1 }] }), p("a"), p("b"), p("c")] },
      { role: "assistant", content: "Two orders ready." },
    ]);
    const res = await new Agent(grok).chat(env, { messages: [{ role: "user", content: "water" }] });
    expect(proposed).toHaveLength(2);
    expect(res.orders).toHaveLength(2);
    const tools = grok.requests[1]!.messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content!));
    expect(tools[0]).toMatchObject({ code: "not_found" });
    expect(tools[3]).toMatchObject({ code: "limit" });
  });

  it("nudges once when Grok describes a basket without proposing it", async () => {
    const { env } = fakeEnv();
    const grok = new FakeGrok([
      { role: "assistant", content: null, tool_calls: [call("c1", "search_items", { need: "water" })] },
      { role: "assistant", content: "I can propose 2 cases of water at Riverside Grocery. Tap Confirm if that works." },
      { role: "assistant", content: null, tool_calls: [call("c2", "propose_order", { store: 3, lines: [{ itemId: 0, qty: 2 }] })] },
      { role: "assistant", content: "Your water order at Riverside Grocery is ready, $11.98. Tap Confirm." },
    ]);
    const res = await new Agent(grok).chat(env, { messages: [{ role: "user", content: "water please" }] });
    expect(res.orders).toHaveLength(1);
    expect(res.reply).toContain("ready");
    expect(grok.requests[2]!.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("stops after 5 rounds and forces a text reply on the last one", async () => {
    const { env } = fakeEnv();
    const loop = { role: "assistant" as const, content: null, tool_calls: [call("s", "search_items", { query: "water" })] };
    const grok = new FakeGrok([loop, loop, loop, loop, { role: "assistant", content: "Here's what I found." }]);
    const res = await new Agent(grok).chat(env, { messages: [{ role: "user", content: "water" }] });
    expect(grok.requests).toHaveLength(5);
    expect(grok.requests[4]!.toolChoice).toBe("none");
    expect(res.reply).toBe("Here's what I found.");
  });

  it("falls back to the scripted planner when Grok is unavailable", async () => {
    const { env } = fakeEnv();
    const grok = new FakeGrok([new GrokUnavailable("spend_limit", "limit")]);
    const res = await new Agent(grok).chat(env, { messages: [{ role: "user", content: "We need water and diapers for the baby" }] });
    expect(res.fallback).toBe(true);
    expect(res.model).toBe("scripted planner");
    expect(res.orders.length).toBeGreaterThanOrEqual(1);
    const items = res.orders.flatMap((o) => o.lines.map((l) => l.name));
    expect(items.some((n) => n.startsWith("Bottled water"))).toBe(true);
    expect(items).toContain("Diapers");
    expect(res.orders.every((o) => o.totalCents <= 20_000)).toBe(true);
    expect(res.reply).toContain("Tap Confirm");
    expect(res.usage.usd).toBe(0);
  });

  it("keeps orders already proposed when Grok breaks mid-turn", async () => {
    const { env } = fakeEnv();
    const grok = new FakeGrok([
      { role: "assistant", content: null, tool_calls: [call("c1", "propose_order", { store: 3, lines: [{ itemId: 0, qty: 2 }] })] },
      new GrokUnavailable("timeout", "slow"),
    ]);
    const res = await new Agent(grok).chat(env, { messages: [{ role: "user", content: "water" }] });
    expect(res.fallback).toBe(true);
    expect(res.orders).toHaveLength(1);
    expect(res.reply).toContain("Riverside Grocery");
  });

  it("tells the model about orders from earlier turns", async () => {
    const { env, proposed } = fakeEnv();
    await env.propose({ store: 3, lines: [{ itemId: 0, qty: 1 }] });
    proposed[0]!.status = "paid";
    const grok = new FakeGrok([{ role: "assistant", content: "Done." }]);
    await new Agent(grok).chat(env, {
      messages: [
        { role: "user", content: "water" },
        { role: "assistant", content: "Order ready.", orders: ["o_1"] },
        { role: "user", content: "and food" },
      ],
    });
    const hist = grok.requests[0]!.messages;
    expect(hist.find((m) => m.role === "assistant")!.content).toContain("o_1 at Riverside Grocery (store 3) $5.99: paid");
  });
});

describe("scripted planner", () => {
  it("reads needs from plain words", () => {
    expect(needsFrom("Storm hit, out of water and food, no power", { kids: false, pet: false })).toEqual(["water", "food", "power"]);
    expect(needsFrom("I need my prescription refilled", { kids: false, pet: false })).toEqual(["medical"]);
    expect(needsFrom("hola", { kids: true, pet: false })).toEqual(["water", "food", "baby"]);
    expect(needsFrom("Need dog food", { kids: false, pet: true })).toContain("pet");
  });

  it("splits across two stores when one can't cover a need, within the caps", async () => {
    const { env } = fakeEnv({ wallet: { window: { spentCents: 0, capCents: 30_000, remainingCents: 30_000, perOrderCapCents: 20_000 } } });
    // The pharmacy has water too, so one stop covers both.
    const one = await plan(env, "Out of water, and I need my prescription refilled");
    expect(one.orders.map((o) => o.storeName)).toEqual(["Oak Street Pharmacy"]);
    expect(one.orders[0]!.lines.map((l) => l.name)).toContain("Prescription refill (copay)");
    // Pet food only at the grocery, the prescription only at the pharmacy: two orders, nearest first.
    const two = await plan(env, "Dog food and my prescription refill");
    expect(two.orders.map((o) => o.storeName)).toEqual(["Riverside Grocery", "Oak Street Pharmacy"]);
    expect(two.orders[1]!.lines.map((l) => l.name)).toContain("Prescription refill (copay)");
    expect(two.orders.reduce((a, o) => a + o.totalCents, 0)).toBeLessThanOrEqual(30_000);
  });

  it("trims the basket to what's left in the 24 h window", async () => {
    const { env } = fakeEnv({ wallet: { window: { spentCents: 28_000, capCents: 30_000, remainingCents: 2_000, perOrderCapCents: 20_000 } } });
    const res = await plan(env, "water and food");
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0]!.totalCents).toBeLessThanOrEqual(2_000);
  });

  it("doesn't shop before aid lands or for a frozen wallet", async () => {
    const pending = await plan(fakeEnv({ wallet: { aid: { cents: 1, landed: false, dueAt: 0, landedAt: null, signature: null, timeToAidMs: null } } }).env, "water");
    expect(pending.orders).toHaveLength(0);
    expect(pending.reply).toMatch(/haven't landed/);
    const frozen = await plan(fakeEnv({ wallet: { frozen: true } }).env, "water");
    expect(frozen.orders).toHaveLength(0);
  });
});

describe("rate limiter", () => {
  it("allows 10 turns per resident and 40 overall per 5 minutes", () => {
    let now = 0;
    const rl = new RateLimiter(10, 40, 300_000, () => now);
    for (let i = 0; i < 10; i++) expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
    expect(rl.retryAfter("a")).toBe(300);
    for (let k = 0; k < 30; k++) expect(rl.take(`r${k}`)).toBe(true);
    expect(rl.take("fresh")).toBe(false);
    now = 300_001;
    expect(rl.take("a")).toBe(true);
    expect(rl.take("fresh")).toBe(true);
  });
});
