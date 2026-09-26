import type { OracleCase } from "@rescu/live";
import { type Grok, GrokUnavailable } from "../grok.js";

const CONCURRENCY = 2;
/** Grok write-ups per run; past this, cases get the template text. */
export const MAX_SUMMARIES = 60;

const SYSTEM =
  "You are the fraud and price watchdog of a disaster relief program. Write exactly 2 or 3 short, plain sentences for a relief official who is not technical: " +
  "what happened, the key numbers, and the one action you recommend. No jargon, no markdown, no bullet points, no greeting. Use dollars, not cents.";

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const shortItem = (name: string) => name.split(",")[0]!.toLowerCase();

/** The facts Grok writes from (numbers only from the case, so it can't invent any). */
export function facts(c: OracleCase): string {
  const e = c.evidence;
  const lines: string[] = [`Case type: ${c.kind.replace("_", " ")}`, `Oracle confidence: ${pct(c.score)} (${c.severity})`];
  switch (e.kind) {
    case "gouging": {
      lines.push(
        `Store: ${c.subjects[0]?.name}`,
        `Item: ${e.item}, now ${usd(e.priceCents)}; nearby stores charged ${usd(e.medianCents)} before the storm (${e.ratio.toFixed(1)}x, the limit is +${e.thresholdPct}%)`,
      );
      if (e.otherItems.length) lines.push(`Also marked up: ${e.otherItems.map((o) => `${shortItem(o.item)} ${o.ratio.toFixed(1)}x`).join(", ")}`);
      lines.push(e.sales ? `Relief purchases at the inflated price so far: ${e.sales}, residents overpaid ${usd(e.overchargeCents)}` : "No relief purchases at the inflated price yet");
      lines.push("Recommended action: suspend the store on-chain so relief payments to it are refused");
      break;
    }
    case "duplicate_identity":
      lines.push(
        `${e.households.length} households registered with the same ${e.key === "device" ? "phone (device)" : e.key === "phone" ? "phone number" : "street address"}: ${e.households.map((h) => `${h.name} (${h.county})`).join("; ")}`,
        `Aid paid to the extra registrations: ${usd(e.duplicateAidCents)}`,
        "Recommended action: freeze these relief wallets until a caseworker verifies identity",
      );
      break;
    case "velocity":
      lines.push(
        `Resident: ${c.subjects[0]?.name}`,
        `${e.orders} purchases, ${usd(e.spentCents)} of ${usd(e.aidCents)} aid spent within ${Math.max(1, Math.round(e.hours))} hours`,
        `Payments the network refused for going over its limits: ${e.capHits}`,
        "Recommended action: freeze the wallet while a caseworker checks in",
      );
      break;
    case "collusion":
      lines.push(
        `Store: ${e.merchantName}`,
        `${e.residents.length} residents spent nearly all of their aid there (${e.residents.map((r) => pct(r.shareAtStore)).join(", ")} of their spending)`,
        `Store takings ${usd(e.storeVolumeCents)} vs about ${usd(e.expectedVolumeCents)} for similar stores nearby; ${pct(e.concentration)} of it from these residents`,
        "Likely aid traded for cash. Recommended action: suspend the store on-chain and freeze the residents' wallets",
      );
      break;
  }
  return lines.join("\n");
}

/** Plain-English write-up without Grok (spend limit, no key, API down). */
export function fallbackText(c: OracleCase): string {
  const e = c.evidence;
  switch (e.kind) {
    case "gouging":
      return `${c.subjects[0]?.name} is charging ${usd(e.priceCents)} for ${shortItem(e.item)}, ${e.ratio.toFixed(1)}x what nearby stores charged before the storm${e.otherItems.length ? `, and marked up ${e.otherItems.length} more item${e.otherItems.length > 1 ? "s" : ""}` : ""}. ${e.sales ? `Residents have overpaid ${usd(e.overchargeCents)} across ${e.sales} relief purchases.` : "No relief purchases at that price yet."} Suspend the store on-chain so relief payments to it are refused.`;
    case "duplicate_identity":
      return `${e.households.length} households registered with the same ${e.key === "device" ? "device" : e.key === "phone" ? "phone number" : "address"}, and ${usd(e.duplicateAidCents)} in aid went to the extra registrations. Freeze these wallets until a caseworker confirms who is who.`;
    case "velocity":
      return `${c.subjects[0]?.name} spent ${usd(e.spentCents)} of ${usd(e.aidCents)} in ${Math.max(1, Math.round(e.hours))} hours${e.capHits ? ` and was refused ${e.capHits} times for going over the limits` : ""}. That is far faster than other households. Freeze the wallet while a caseworker checks in.`;
    case "collusion":
      return `${e.residents.length} residents spent nearly all of their aid at ${e.merchantName}, whose takings (${usd(e.storeVolumeCents)}) are far above similar stores nearby (${usd(e.expectedVolumeCents)}). This looks like aid traded for cash. Suspend the store and freeze the residents' wallets.`;
  }
}

/** Grok write-ups for opened cases: highest priority first, two at a time, capped per run, cached on the case. */
export class Summarizer {
  private queue: { id: string; priority: number }[] = [];
  private inFlight = 0;
  count = 0;
  usd = 0;
  private stopped = false;

  constructor(
    private readonly grok: Grok,
    private readonly get: (id: string) => OracleCase | undefined,
    private readonly changed: (c: OracleCase) => void,
  ) {}

  stop() {
    this.stopped = true;
    this.queue = [];
  }

  enqueue(id: string, priority: number) {
    if (this.queue.some((q) => q.id === id)) return;
    this.queue.push({ id, priority });
    this.queue.sort((a, b) => b.priority - a.priority);
    this.pump();
  }

  private pump() {
    while (!this.stopped && this.inFlight < CONCURRENCY && this.queue.length) {
      const next = this.queue.shift()!;
      const c = this.get(next.id);
      if (!c || c.summary.status !== "pending") continue;
      this.inFlight++;
      void this.write(c).finally(() => {
        this.inFlight--;
        this.pump();
      });
    }
  }

  private async write(c: OracleCase) {
    if (this.count >= MAX_SUMMARIES || !this.grok.enabled) {
      c.summary = { status: "fallback", text: fallbackText(c), model: null };
      this.changed(c);
      return;
    }
    this.count++;
    try {
      const r = await this.grok.chat({
        purpose: "oracle",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: facts(c) },
        ],
        maxTokens: 160,
        temperature: 0.2,
        timeoutMs: 15_000,
      });
      if (this.stopped) return;
      this.usd += r.usage.usd;
      const text = (r.message.content ?? "").replace(/\*\*/g, "").trim();
      c.summary = text ? { status: "ready", text, model: r.model } : { status: "fallback", text: fallbackText(c), model: null };
    } catch (err) {
      if (this.stopped) return;
      if (!(err instanceof GrokUnavailable)) console.error("oracle summary:", (err as Error).message);
      c.summary = { status: "fallback", text: fallbackText(c), model: null };
    }
    this.changed(c);
  }
}
