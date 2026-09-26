import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

/**
 * Grok (xAI, OpenAI-compatible chat completions) with a hard spend limit. Credits are $25 total
 * and the API stops when they run out, so every call is priced from the API's own usage numbers
 * and added to a ledger on disk; past XAI_SPEND_LIMIT_USD (default $20) `chat` refuses and callers
 * fall back to their scripted path. Only real people's requests and oracle write-ups call this,
 * never the simulated households.
 */

export type GrokPurpose = "agent" | "oracle";

export interface GrokMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: GrokToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface GrokToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface GrokTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface GrokResult {
  message: GrokMessage;
  finishReason: string;
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number; usd: number };
  model: string;
  ms: number;
}

export class GrokUnavailable extends Error {
  constructor(
    readonly reason: "no_key" | "spend_limit" | "api_error" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "GrokUnavailable";
  }
}

/** USD per 1M tokens: input, cached input, output (xAI console, Fri Sep 25). */
const PRICES: [RegExp, number, number, number][] = [
  [/^grok-build/, 1, 0.2, 2],
  [/^grok-4\.20|^grok-4\.3/, 1.25, 0.2, 2.5],
  [/^grok-4\.[5-9]/, 2, 0.3, 6],
];
const DEFAULT_PRICE: [number, number, number] = [2, 0.5, 6];

function price(model: string): [number, number, number] {
  const p = PRICES.find(([re]) => re.test(model));
  return p ? [p[1], p[2], p[3]] : DEFAULT_PRICE;
}

interface Ledger {
  spentUsd: number;
  calls: number;
  byPurpose: Record<string, { calls: number; usd: number; inputTokens: number; outputTokens: number }>;
}

export class Grok {
  readonly models: Record<GrokPurpose, string>;
  readonly limitUsd: number;
  private ledger: Ledger;
  private readonly ledgerPath: string;
  private readonly logPath: string;
  /** Worst-case cost of calls still in flight, so parallel calls can't overshoot the limit. */
  private reservedUsd = 0;

  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; agentModel: string; oracleModel: string; limitUsd: number; ledgerPath?: string },
  ) {
    this.models = { agent: opts.agentModel, oracle: opts.oracleModel };
    this.limitUsd = opts.limitUsd;
    this.ledgerPath = opts.ledgerPath ?? `${homedir()}/.config/rescu/grok-usage.json`;
    this.logPath = this.ledgerPath.replace(/\.json$/, ".log");
    this.ledger = this.load();
  }

  static fromEnv(): Grok {
    return new Grok({
      apiKey: process.env.XAI_API_KEY ?? "",
      baseUrl: process.env.XAI_BASE_URL || "https://api.x.ai/v1",
      agentModel: process.env.XAI_MODEL_AGENT || "grok-4.20-non-reasoning",
      oracleModel: process.env.XAI_MODEL_ORACLE || "grok-4.20-non-reasoning",
      limitUsd: Number(process.env.XAI_SPEND_LIMIT_USD || 20),
    });
  }

  get enabled() {
    return !!this.opts.apiKey && this.remainingUsd > 0.05;
  }

  get spentUsd() {
    return this.ledger.spentUsd;
  }

  get remainingUsd() {
    return Math.max(0, this.limitUsd - this.ledger.spentUsd - this.reservedUsd);
  }

  stats() {
    return { spentUsd: round4(this.ledger.spentUsd), limitUsd: this.limitUsd, calls: this.ledger.calls, byPurpose: this.ledger.byPurpose, models: this.models };
  }

  /**
   * One chat completion. Throws GrokUnavailable (no key, over the limit, API error, timeout);
   * callers must catch it and fall back.
   */
  async chat(req: {
    purpose: GrokPurpose;
    messages: GrokMessage[];
    tools?: GrokTool[];
    toolChoice?: "auto" | "none" | "required";
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  }): Promise<GrokResult> {
    if (!this.opts.apiKey) throw new GrokUnavailable("no_key", "XAI_API_KEY is not set");
    const model = this.models[req.purpose];
    const [pin, , pout] = price(model);
    const maxTokens = req.maxTokens ?? 600;
    const chars = JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length;
    const worst = ((chars / 3) * pin + maxTokens * pout) / 1e6;
    if (this.ledger.spentUsd + this.reservedUsd + worst > this.limitUsd) {
      throw new GrokUnavailable("spend_limit", `Grok spend limit reached ($${this.ledger.spentUsd.toFixed(2)} of $${this.limitUsd})`);
    }
    this.reservedUsd += worst;
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 25_000);
    try {
      const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model,
          messages: req.messages,
          ...(req.tools?.length ? { tools: req.tools, tool_choice: req.toolChoice ?? "auto" } : {}),
          max_tokens: maxTokens,
          temperature: req.temperature ?? 0.3,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new GrokUnavailable("api_error", `xAI ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as {
        model?: string;
        choices: { message: GrokMessage; finish_reason: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
      };
      const u = body.usage ?? {};
      const inputTokens = u.prompt_tokens ?? 0;
      const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
      const outputTokens = (u.completion_tokens ?? 0) + (u.completion_tokens_details?.reasoning_tokens ?? 0);
      const usd = this.charge(req.purpose, model, inputTokens, cachedTokens, outputTokens);
      const choice = body.choices[0];
      if (!choice) throw new GrokUnavailable("api_error", "xAI returned no choices");
      return { message: choice.message, finishReason: choice.finish_reason, usage: { inputTokens, cachedTokens, outputTokens, usd }, model: body.model ?? model, ms: Date.now() - t0 };
    } catch (err) {
      if (err instanceof GrokUnavailable) throw err;
      if ((err as Error).name === "AbortError") throw new GrokUnavailable("timeout", "Grok took too long");
      throw new GrokUnavailable("api_error", (err as Error).message);
    } finally {
      clearTimeout(timer);
      this.reservedUsd = Math.max(0, this.reservedUsd - worst);
    }
  }

  private charge(purpose: GrokPurpose, model: string, input: number, cached: number, output: number): number {
    const [pin, pcached, pout] = price(model);
    const usd = ((input - cached) * pin + cached * pcached + output * pout) / 1e6;
    const l = this.ledger;
    l.spentUsd += usd;
    l.calls++;
    const p = (l.byPurpose[purpose] ??= { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 });
    p.calls++;
    p.usd += usd;
    p.inputTokens += input;
    p.outputTokens += output;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      writeFileSync(this.ledgerPath, JSON.stringify(l, null, 2));
      appendFileSync(this.logPath, `${new Date().toISOString()} ${purpose} ${model} in=${input} cached=${cached} out=${output} usd=${usd.toFixed(5)} total=${l.spentUsd.toFixed(4)}\n`);
    } catch (err) {
      console.error("grok ledger:", (err as Error).message);
    }
    return usd;
  }

  private load(): Ledger {
    try {
      const l = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Ledger;
      if (typeof l.spentUsd === "number") return { spentUsd: l.spentUsd, calls: l.calls ?? 0, byPurpose: l.byPurpose ?? {} };
    } catch {
      // First run.
    }
    return { spentUsd: 0, calls: 0, byPurpose: {} };
  }
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
