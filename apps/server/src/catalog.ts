import type { MerchantCategory } from "@rescu/live";

/** What a purchase is for. Payments are tagged with the basket's main need. */
export type Need = "water" | "food" | "baby" | "medical" | "power" | "fuel" | "shelter" | "cleanup" | "hygiene" | "pet";

export const NEEDS: Need[] = ["water", "food", "baby", "medical", "power", "fuel", "shelter", "cleanup", "hygiene", "pet"];

export interface Item {
  id: number;
  name: string;
  need: Need;
  /** Pre-storm baseline price, cents. */
  cents: number;
  maxQty: number;
  sells: MerchantCategory[];
}

const G: MerchantCategory = "grocery";
const P: MerchantCategory = "pharmacy";
const H: MerchantCategory = "hardware";
const S: MerchantCategory = "general";

// One shared catalog of essentials with typical Gulf Coast shelf prices.
const RAW: [string, Need, number, number, MerchantCategory[]][] = [
  ["Bottled water, 24-pack", "water", 599, 4, [G, S, P]],
  ["Water, 1-gallon jug", "water", 149, 6, [G, S, P]],
  ["Water purification tablets", "water", 899, 2, [H, S, P]],
  ["Canned soup", "food", 229, 8, [G, S]],
  ["Canned beans", "food", 139, 8, [G, S]],
  ["Canned tuna", "food", 179, 8, [G, S]],
  ["Peanut butter", "food", 349, 3, [G, S]],
  ["Bread", "food", 299, 3, [G, S]],
  ["Crackers", "food", 329, 4, [G, S, P]],
  ["Cereal", "food", 449, 3, [G, S]],
  ["Shelf-stable milk", "food", 399, 4, [G, S]],
  ["Ready-to-eat meals, 3-pack", "food", 1899, 3, [H, S]],
  ["Ice, 10 lb bag", "food", 399, 4, [G, S]],
  ["Baby formula", "baby", 2499, 2, [G, P, S]],
  ["Diapers", "baby", 2699, 2, [G, P, S]],
  ["Baby wipes", "baby", 399, 3, [G, P, S]],
  ["Pain reliever", "medical", 799, 2, [P, G, S]],
  ["Prescription refill (copay)", "medical", 1500, 2, [P]],
  ["Insulin (copay)", "medical", 3500, 1, [P]],
  ["First aid kit", "medical", 1999, 1, [P, H, S]],
  ["Bandages", "medical", 449, 3, [P, G, S]],
  ["Antiseptic", "medical", 549, 2, [P, S]],
  ["Oral rehydration salts", "medical", 899, 2, [P]],
  ["Insect repellent", "medical", 699, 2, [P, G, H, S]],
  ["AA batteries, 8-pack", "power", 999, 3, [G, P, H, S]],
  ["D batteries, 4-pack", "power", 899, 3, [H, S, G]],
  ["LED flashlight", "power", 1299, 2, [H, S, P]],
  ["Battery lantern", "power", 2499, 1, [H, S]],
  ["Phone power bank", "power", 2999, 1, [P, S, H]],
  ["Fuel, per gallon", "fuel", 349, 10, [S]],
  ["Gas can, 5 gal", "fuel", 2499, 1, [H, S]],
  ["Propane canister", "fuel", 699, 4, [H, S]],
  ["Tarp, 10 x 12 ft", "shelter", 1999, 2, [H, S]],
  ["Duct tape", "shelter", 699, 2, [H, S]],
  ["Plywood sheet", "shelter", 3499, 3, [H]],
  ["Roofing nails", "shelter", 899, 1, [H]],
  ["Blanket", "shelter", 1499, 2, [S, P]],
  ["Work gloves", "cleanup", 999, 2, [H, S]],
  ["Contractor trash bags", "cleanup", 1299, 2, [H, G, S]],
  ["Bleach", "cleanup", 499, 2, [G, H, S]],
  ["Mold cleaner", "cleanup", 1199, 2, [H, G, S]],
  ["Shovel", "cleanup", 2499, 1, [H]],
  ["Toilet paper, 12 rolls", "hygiene", 1099, 2, [G, P, S]],
  ["Soap and hygiene kit", "hygiene", 999, 2, [P, G, S]],
  ["Toothbrush and toothpaste", "hygiene", 599, 2, [P, G, S]],
  ["Pet food", "pet", 1499, 2, [G, S]],
];

export const ITEMS: Item[] = RAW.map(([name, need, cents, maxQty, sells], id) => ({ id, name, need, cents, maxQty, sells }));

/** Over the $200 per-order cap on purpose: the chain turns these away. */
export const GENERATOR: Item = { id: ITEMS.length, name: "Portable generator", need: "power", cents: 49_900, maxQty: 1, sells: [H] };
export const ALL_ITEMS: Item[] = [...ITEMS, GENERATOR];

export const STOCK: Record<MerchantCategory, Item[]> = {
  pharmacy: ITEMS.filter((i) => i.sells.includes("pharmacy")),
  grocery: ITEMS.filter((i) => i.sells.includes("grocery")),
  hardware: ITEMS.filter((i) => i.sells.includes("hardware")),
  general: ITEMS.filter((i) => i.sells.includes("general")),
};

/** Which store types carry anything for a need. */
export const SELLS_NEED: Record<Need, MerchantCategory[]> = Object.fromEntries(
  NEEDS.map((n) => [n, (["pharmacy", "grocery", "hardware", "general"] as const).filter((c) => STOCK[c].some((i) => i.need === n))]),
) as Record<Need, MerchantCategory[]>;

/** Merchant's shelf price for an item: baseline +/-10%, fixed per merchant and item. */
export function shelfCents(merchantIdx: number, item: Item): number {
  let h = (merchantIdx * 2654435761 + item.id * 40503) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  const f = 0.9 + ((h % 10_000) / 10_000) * 0.2;
  return Math.round((item.cents * f) / 10) * 10 - 1;
}

/**
 * How much a household wants each need, by days since its aid landed: water, food and power
 * first, then cleanup and repairs, then ordinary groceries.
 */
export function needWeights(daysSinceAid: number, kids: boolean, pet: boolean): number[] {
  const early = daysSinceAid < 3;
  const mid = !early && daysSinceAid < 10;
  const w: Record<Need, number> = early
    ? { water: 3, food: 3, baby: 2, medical: 1.5, power: 2.5, fuel: 1.2, shelter: 1, cleanup: 0.3, hygiene: 0.5, pet: 0.6 }
    : mid
      ? { water: 1.5, food: 3, baby: 1.5, medical: 1, power: 1, fuel: 0.8, shelter: 2, cleanup: 2.5, hygiene: 1.2, pet: 0.6 }
      : { water: 0.8, food: 3, baby: 1.2, medical: 1, power: 0.4, fuel: 0.5, shelter: 1, cleanup: 1.5, hygiene: 1.5, pet: 0.6 };
  if (!kids) w.baby = 0;
  if (!pet) w.pet = 0;
  return NEEDS.map((n) => w[n]);
}
