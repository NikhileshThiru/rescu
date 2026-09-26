import type { Listing, Need, Offer, Order, StoreSummary, WalletView } from "@rescu/live";
import { ApiFail } from "../network/errors.js";
import type { AgentEnv } from "./env.js";

/**
 * The scripted shopper Rescu falls back to when Grok is unavailable (no key, spend limit, API
 * error, timeout): keywords -> needs -> nearby offers -> one sensible basket at the best nearby
 * store (a second one if the first can't cover a need), proposed for the resident to confirm.
 */

const KEYWORDS: [RegExp, Need][] = [
  [/water|thirst|drink|agua|hydrat/i, "water"],
  [/food|hungry|eat|meal|groceries|bread|canned|comida|starv|milk/i, "food"],
  [/baby|formula|diaper|infant|wipes|bebe|bebé|pañal/i, "baby"],
  [/medic|prescri|refill|insulin|pill|meds\b|pharma|first aid|bandage|hurt|injur|medicina/i, "medical"],
  [/power|batter|flashlight|light|dark|phone|charg|lantern|electric|luz/i, "power"],
  [/fuel|gas\b|gasoline|propane|generator/i, "fuel"],
  [/roof|tarp|leak|shelter|window|board|plywood|blanket|cold/i, "shelter"],
  [/clean|mold|mud|flood|trash|bleach|gloves|debris/i, "cleanup"],
  [/soap|toilet|hygien|toothbrush|shower|wash/i, "hygiene"],
  [/\bdog|\bcat\b|pet|puppy|kitten/i, "pet"],
];

/** Essentials first; the budget is trimmed from the end. */
const PRIORITY: Need[] = ["water", "food", "baby", "medical", "power", "pet", "hygiene", "fuel", "shelter", "cleanup"];

/** `required`: the need only counts as covered at a store that has this item (a prescription, not just aspirin). */
type Pick = { name: string; qty: (size: number) => number; required?: boolean };
const q = (n: number) => () => n;

function picksFor(need: Need, text: string): Pick[] {
  switch (need) {
    case "water":
      return [
        { name: "Bottled water, 24-pack", qty: (s) => Math.ceil(s / 2) },
        { name: "Water, 1-gallon jug", qty: (s) => Math.min(6, s * 2) },
      ];
    case "food":
      return [
        { name: "Canned soup", qty: (s) => Math.min(8, s * 2) },
        { name: "Bread", qty: (s) => (s > 3 ? 2 : 1) },
        { name: "Peanut butter", qty: q(1) },
        { name: "Canned beans", qty: (s) => Math.min(8, s) },
        { name: "Crackers", qty: q(1) },
      ];
    case "baby":
      return [
        { name: "Baby formula", qty: q(2) },
        { name: "Diapers", qty: q(1) },
        { name: "Baby wipes", qty: q(1) },
      ];
    case "medical":
      return [
        ...(/insulin/i.test(text) ? [{ name: "Insulin (copay)", qty: q(1), required: true }] : []),
        ...(/prescri|refill|meds\b|pill/i.test(text) ? [{ name: "Prescription refill (copay)", qty: q(1), required: true }] : []),
        { name: "Pain reliever", qty: q(1) },
        { name: "First aid kit", qty: q(1) },
      ];
    case "power":
      return [
        { name: "AA batteries, 8-pack", qty: q(1) },
        { name: "LED flashlight", qty: q(1) },
        { name: "Phone power bank", qty: q(1) },
      ];
    case "fuel":
      return [{ name: "Fuel, per gallon", qty: q(5) }, { name: "Propane canister", qty: q(2) }];
    case "shelter":
      return [
        { name: "Tarp, 10 x 12 ft", qty: q(1) },
        { name: "Duct tape", qty: q(1) },
      ];
    case "cleanup":
      return [
        { name: "Bleach", qty: q(1) },
        { name: "Contractor trash bags", qty: q(1) },
        { name: "Work gloves", qty: q(1) },
      ];
    case "hygiene":
      return [
        { name: "Toilet paper, 12 rolls", qty: q(1) },
        { name: "Soap and hygiene kit", qty: q(1) },
      ];
    case "pet":
      return [{ name: "Pet food", qty: q(1) }];
  }
}

export function needsFrom(text: string, household: { kids: boolean; pet: boolean }): Need[] {
  const found = new Set<Need>();
  for (const [re, need] of KEYWORDS) if (re.test(text)) found.add(need);
  if (!found.size) {
    found.add("water");
    found.add("food");
    if (household.kids) found.add("baby");
  }
  if (found.has("baby") && !household.kids && !/baby|formula|diaper|infant/i.test(text)) found.delete("baby");
  return PRIORITY.filter((n) => found.has(n));
}

interface Shelf {
  store: StoreSummary;
  items: Map<string, Listing>;
}

type Line = { itemId: number; name: string; qty: number; unitCents: number; need: Need };

function basket(shelf: Shelf, needs: Need[], text: string, size: number): { lines: Line[]; covered: Need[] } {
  const lines: Line[] = [];
  const covered: Need[] = [];
  for (const need of needs) {
    let got = false;
    const picks = picksFor(need, text);
    if (picks.some((p) => p.required) && !picks.some((p) => p.required && (shelf.items.get(p.name)?.stock ?? 0) > 0)) continue;
    for (const p of picks) {
      const l = shelf.items.get(p.name);
      if (!l || l.stock <= 0) continue;
      const qty = Math.max(1, Math.min(p.qty(size), l.maxQty, l.stock));
      lines.push({ itemId: l.itemId, name: l.name, qty, unitCents: l.priceCents, need });
      got = true;
      // Water and fuel: one kind is enough.
      if (need === "water" || need === "fuel") break;
    }
    if (got) covered.push(need);
  }
  return { lines, covered };
}

/** Shrinks a basket to the budget: fewer of the lowest-priority lines first, then drops them. */
function fit(lines: Line[], budget: number): Line[] {
  const out = lines.map((l) => ({ ...l }));
  const total = () => out.reduce((a, l) => a + l.qty * l.unitCents, 0);
  while (out.length && total() > budget) {
    const last = out[out.length - 1]!;
    if (last.qty > 1) last.qty--;
    else out.pop();
  }
  return out;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function listItems(lines: { qty: number; name: string }[]): string {
  const names = lines.map((l) => (l.qty > 1 ? `${l.qty} ${l.name.toLowerCase()}` : l.name.toLowerCase()));
  if (names.length <= 1) return names.join("");
  if (names.length <= 4) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

export interface PlanResult {
  reply: string;
  orders: Order[];
  tools: { name: string; summary: string }[];
}

/** One scripted turn: always safe to call (never throws on market conditions). */
export async function plan(env: AgentEnv, text: string, wallet?: WalletView): Promise<PlanResult> {
  const tools: PlanResult["tools"] = [];
  const w = wallet ?? (await env.wallet());
  tools.push({ name: "get_wallet", summary: `Wallet: ${dollars(w.balanceCents)} balance, ${dollars(w.window.remainingCents)} left today` });
  if (!w.aid.landed) return { reply: "Your relief dollars haven't landed yet. They arrive the moment the storm reaches your area, and I can shop for you right after.", orders: [], tools };
  if (w.frozen) return { reply: "This wallet is on hold while the oracle reviews it, so I can't place orders right now.", orders: [], tools };

  const needs = needsFrom(text, env.resident);
  const size = Math.max(1, env.resident.size);
  let budget = Math.min(w.window.perOrderCapCents, w.window.remainingCents, w.balanceCents);
  let dayLeft = Math.min(w.window.remainingCents, w.balanceCents);
  if (budget < 300) return { reply: `You've used this 24-hour window's limit (${dollars(w.window.capCents)} per day). I can shop again once it frees up.`, orders: [], tools };

  // Nearby shelves for these needs.
  const shelves = new Map<number, Shelf>();
  for (const need of needs) {
    const offers: Offer[] = env.search({ need, limit: 25, openOnly: true });
    for (const o of offers) {
      let s = shelves.get(o.store.idx);
      if (!s) {
        s = { store: o.store, items: new Map() };
        shelves.set(o.store.idx, s);
      }
      s.items.set(o.item.name, o.item);
    }
  }
  const stores = [...shelves.values()].sort((a, b) => (a.store.distanceKm ?? 0) - (b.store.distanceKm ?? 0)).slice(0, 12);
  tools.push({ name: "search_items", summary: `Searched ${needs.join(", ")}: ${stores.length} ${stores.length === 1 ? "store" : "stores"} nearby` });
  if (!stores.length) return { reply: `I couldn't find ${needs.join(" or ")} in stock at an open relief store near you right now. Stores reopen as the storm clears; try again soon.`, orders: [], tools };

  const orders: Order[] = [];
  let remaining = [...needs];
  const tried = new Set<number>();
  while (orders.length < 2 && remaining.length && budget >= 300) {
    const scored = stores
      .filter((s) => !tried.has(s.store.idx))
      .map((s) => ({ s, b: basket(s, remaining, text, size) }))
      .filter((x) => x.b.lines.length)
      .sort((a, b) => b.b.covered.length * 10 - (b.s.store.distanceKm ?? 0) * 0.4 - (a.b.covered.length * 10 - (a.s.store.distanceKm ?? 0) * 0.4));
    const best = scored[0];
    if (!best) break;
    tried.add(best.s.store.idx);
    const lines = fit(best.b.lines, budget);
    if (!lines.length) break;
    try {
      const o = await env.propose({
        store: best.s.store.idx,
        lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty })),
        note: `${needs.map((n) => n).join(", ")} for ${size === 1 ? "one person" : `${size} people`}, about 2-3 days`,
      });
      orders.push(o);
      tools.push({ name: "propose_order", summary: `Proposed ${dollars(o.totalCents)} at ${o.storeName}` });
      const got = new Set(lines.map((l) => l.need));
      remaining = remaining.filter((n) => !got.has(n));
      dayLeft -= o.totalCents;
      budget = Math.min(w.window.perOrderCapCents, dayLeft);
    } catch (err) {
      if (!(err instanceof ApiFail)) throw err;
      // Closed, out of stock or over a cap at this store: try the next one.
    }
  }

  if (!orders.length) return { reply: "I couldn't put together an order that fits your limits at an open store nearby. Try asking for fewer things.", orders, tools };
  const parts = orders.map((o, i) => {
    const km = o.pickup.distanceKm;
    const where = `${o.storeName}${km !== null ? `, ${km < 1 ? "under 1" : Math.round(km)} km away` : ""}`;
    return `${i === 0 ? "I put together an order at" : "And a second one at"} ${where}: ${listItems(o.lines)}, ${dollars(o.totalCents)}.`;
  });
  const missing = remaining.length ? ` I couldn't find ${remaining.join(" or ")} in stock nearby right now.` : "";
  return { reply: `${parts.join(" ")} Tap Confirm to pay from your relief wallet.${missing}`, orders, tools };
}
