import { type ChatInput, type ChatResult, MARKET_TOOLS, type MarketToolName, type Order, type WalletView } from "@rescu/live";
import { z } from "zod";
import type { GrokMessage, GrokPurpose, GrokResult, GrokTool } from "../grok.js";
import { toolError } from "../market/tools.js";
import type { AgentEnv } from "./env.js";
import { plan } from "./planner.js";

/**
 * Grok as the resident's relief shopper: tool calling over the Relief Market's own handlers
 * (the same ones MCP serves), minus `confirm_order`: Grok proposes, the resident taps Confirm.
 * Any Grok failure (no key, spend limit, API error, timeout) drops to the scripted planner.
 */

export interface GrokLike {
  readonly models: Record<GrokPurpose, string>;
  chat(req: { purpose: GrokPurpose; messages: GrokMessage[]; tools?: GrokTool[]; toolChoice?: "auto" | "none" | "required"; maxTokens?: number; temperature?: number; timeoutMs?: number }): Promise<GrokResult>;
}

const MAX_ROUNDS = 5;
const MAX_ORDERS = 2;
const HISTORY = 12;
const FALLBACK_MODEL = "scripted planner";

const GROK_TOOLS: GrokTool[] = (Object.keys(MARKET_TOOLS) as MarketToolName[])
  .filter((name) => name !== "confirm_order")
  .map((name) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(MARKET_TOOLS[name].input) as Record<string, unknown>;
    return { type: "function", function: { name, description: MARKET_TOOLS[name].description, parameters } };
  });

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function systemPrompt(env: AgentEnv, w: WalletView): string {
  const r = env.resident;
  const who = [`${r.size} ${r.size === 1 ? "person" : "people"}`, r.kids ? "young kids" : null, r.pet ? "a dog" : null].filter(Boolean).join(", ");
  return [
    `You are Rescu's relief shopping assistant for ${r.name}, who lives in ${r.county}. Household: ${who}. It is ${env.today()}, just after Hurricane ${env.stormName}.`,
    `Their relief wallet: ${dollars(w.balanceCents)} balance, ${dollars(w.window.remainingCents)} left in the rolling 24-hour limit, at most ${dollars(w.window.perOrderCapCents)} per order. ${w.agent.approved ? `They let you spend up to ${dollars(w.agent.allowanceCents)} more.` : "They haven't granted you a spending allowance yet (the app asks them when they confirm)."}${w.aid.landed ? "" : " Their aid hasn't landed yet: say so, you can still look things up."}${w.frozen ? " The wallet is frozen by the oracle: don't propose orders." : ""}`,
    "Relief dollars only work at verified relief stores; the resident picks the order up at the store.",
    "Rules:",
    "- The wallet above is current (no need to call get_wallet). Search (search_items) before proposing, all searches in one step as parallel calls. Only use store numbers and itemIds from tool results.",
    "- One store per order. Prefer the nearest open store that has most of what they need.",
    "- Quantities for this household for about 2-3 days, within each item's maxQty and stock.",
    "- Every order must stay under $200, under what's left in the 24-hour window, and under the balance (and within the allowance they gave you, if any).",
    "- Essentials first (water, food, baby, medicine, power). At most 2 orders per turn.",
    "- After searching, call propose_order for the best basket right away (don't ask first: proposing never pays).",
    "- Then reply in 2-4 short, warm, natural sentences: name the store, how far it is and the total, and ask them to tap Confirm. Example: \"Pine Street Grocery, 4 km away, has water, canned food and formula. I put together a $86.40 basket that should last about three days. Tap Confirm and pick it up at the store.\" Never say you paid or ordered; nothing is paid until they confirm in the app.",
    "- If propose_order returns an error, fix the basket (other items, smaller quantities or another store) and propose again. Only mention a basket you actually proposed.",
    "- If something isn't available nearby, say so plainly. Reply in the user's language. Plain text only: no markdown, tables or lists.",
  ].join("\n");
}

/** Past turns as the model sees them; assistant turns carry a note about the orders they proposed. */
function history(env: AgentEnv, messages: ChatInput["messages"]): GrokMessage[] {
  return messages.slice(-HISTORY).map((m) => {
    let content = m.content.slice(0, 1_200);
    if (m.role === "assistant" && m.orders?.length) {
      const notes = m.orders
        .map((id) => env.order(id))
        .filter((o): o is Order => !!o)
        .map((o) => `${o.id} at ${o.storeName} (store ${o.store}) ${dollars(o.totalCents)}: ${o.status}${o.rule ? ` (${o.rule})` : ""}`);
      if (notes.length) content += `\n[Orders from this reply: ${notes.join("; ")}]`;
    }
    return { role: m.role, content };
  });
}

export class Agent {
  constructor(private readonly grok: GrokLike) {}

  async chat(env: AgentEnv, input: ChatInput): Promise<ChatResult> {
    const t0 = Date.now();
    const last = [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const wallet = await env.wallet();
    const usage = { inputTokens: 0, outputTokens: 0, usd: 0 };
    const tools: ChatResult["tools"] = [];
    const orders: Order[] = [];
    const messages: GrokMessage[] = [{ role: "system", content: systemPrompt(env, wallet) }, ...history(env, input.messages)];
    let model = this.grok.models.agent;
    let reply = "";
    let rounds = 0;
    let nudged = false;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        rounds++;
        const lastRound = round === MAX_ROUNDS - 1;
        const res = await this.grok.chat({
          purpose: "agent",
          messages,
          tools: GROK_TOOLS,
          toolChoice: lastRound ? "none" : "auto",
          maxTokens: 450,
          temperature: 0.2,
          timeoutMs: 20_000,
        });
        model = res.model;
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        usage.usd += res.usage.usd;
        const calls = res.message.tool_calls ?? [];
        if (!calls.length || lastRound) {
          reply = (res.message.content ?? "").trim();
          // It described a basket but never proposed it: one nudge to actually put the order up.
          if (!lastRound && !nudged && !orders.length && tools.some((t) => t.name === "search_items" || t.name === "get_store") && /confirm|order|propos/i.test(reply)) {
            nudged = true;
            messages.push({ role: "assistant", content: reply });
            messages.push({ role: "user", content: "Please put that order up now with propose_order (I'll confirm it in the app), then tell me in 2-3 sentences." });
            reply = "";
            continue;
          }
          break;
        }
        messages.push({ role: "assistant", content: res.message.content ?? null, tool_calls: calls });
        for (const call of calls) {
          const name = call.function.name as MarketToolName;
          let content: unknown;
          if (!(name in MARKET_TOOLS) || name === "confirm_order") {
            content = { error: `${call.function.name} isn't available; the resident confirms orders in the app.`, code: "not_allowed" };
          } else if (name === "propose_order" && orders.length >= MAX_ORDERS) {
            content = { error: `Already proposed ${MAX_ORDERS} orders this turn. Reply to the resident now.`, code: "limit" };
          } else {
            try {
              const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
              const out = await env.tool(name, args);
              content = out.result;
              tools.push({ name, summary: out.summary });
              if (out.order) {
                const i = orders.findIndex((o) => o.id === out.order!.id);
                if (i >= 0) orders[i] = out.order;
                else orders.push(out.order);
              }
            } catch (err) {
              content = toolError(err);
              tools.push({ name, summary: `${name.replace(/_/g, " ")}: ${(content as { error: string }).error.slice(0, 80)}` });
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(content) });
        }
      }
    } catch (err) {
      // Grok is unavailable (or broke mid-turn): the scripted planner takes over.
      const why = (err as { reason?: string }).reason ?? (err as Error).message;
      console.warn(`agent: Grok unavailable for resident ${env.resident.idx} (${why}); scripted planner`);
      if (orders.length) {
        reply = summarize(orders);
      } else {
        const p = await plan(env, last, wallet);
        tools.push(...p.tools);
        orders.push(...p.orders);
        reply = p.reply;
      }
      this.log(env, rounds, usage, Date.now() - t0, true);
      return { reply, orders, tools, model: FALLBACK_MODEL, fallback: true, usage: round(usage) };
    }
    const shopped = tools.some((t) => t.name === "search_items" || t.name === "get_store" || t.name === "propose_order");
    if (!orders.length && shopped && /propos|basket|confirm/i.test(reply)) {
      // Grok described a basket it never managed to put up (a line sold out mid-turn, or it ran
      // out of rounds). The scripted planner puts one up, so the reply is never an empty promise.
      const p = await plan(env, last);
      tools.push(...p.tools.filter((t) => t.name !== "get_wallet"));
      orders.push(...p.orders);
      reply = p.reply;
    }
    if (!reply) reply = orders.length ? summarize(orders) : "Sorry, I couldn't put that together. Could you say what you need, like water, food or medicine?";
    this.log(env, rounds, usage, Date.now() - t0, false);
    return { reply, orders, tools, model, fallback: false, usage: round(usage) };
  }

  private log(env: AgentEnv, rounds: number, u: ChatResult["usage"], ms: number, fallback: boolean) {
    console.log(
      `agent turn: resident ${env.resident.idx} (${env.resident.name}) rounds=${rounds} in=${u.inputTokens} out=${u.outputTokens} usd=${u.usd.toFixed(5)} ${ms} ms${fallback ? " FALLBACK" : ""}`,
    );
  }
}

function summarize(orders: Order[]): string {
  const parts = orders.map((o) => `${o.storeName}${o.pickup.distanceKm !== null ? ` (${Math.max(1, Math.round(o.pickup.distanceKm))} km)` : ""}, ${dollars(o.totalCents)}`);
  return `Here's what I put together: ${parts.join("; ")}. Tap Confirm to pay from your relief wallet.`;
}

const round = (u: ChatResult["usage"]) => ({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, usd: Math.round(u.usd * 1e6) / 1e6 });

export { GROK_TOOLS };
