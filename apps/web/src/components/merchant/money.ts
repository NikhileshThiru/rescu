import type { FeedOrigin, MerchantCategory } from "@rescu/live";

/** Integer cents -> "$1,234.56". */
export function money(cents: number): string {
  const neg = cents < 0;
  const s = (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? "-" : ""}$${s}`;
}

/** Whole dollars for big numbers: "$12,480", "$1.2M". */
export function moneyShort(cents: number): string {
  const d = cents / 100;
  if (Math.abs(d) >= 1e6) return `$${(d / 1e6).toFixed(1)}M`;
  if (Math.abs(d) >= 1e4) return `$${Math.round(d).toLocaleString("en-US")}`;
  return money(cents);
}

export const CATEGORY_LABEL: Record<MerchantCategory, string> = {
  grocery: "Grocery",
  pharmacy: "Pharmacy",
  hardware: "Hardware",
  general: "General store",
};

export const ORIGIN_LABEL: Record<FeedOrigin, string> = {
  sim: "Resident",
  shop: "Relief app",
  agent: "Grok agent",
  mcp: "Outside agent",
  counter: "Counter QR",
  join: "Phone",
  oracle: "Oracle",
  breakit: "Attack test",
};

/** "Sat 2:40 PM" in the storm's time zone. */
export function simClock(t: number): string {
  return new Date(t * 1000).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" });
}

/** Explorer links need the run's cluster query; `null` when the run isn't known yet. */
export function txHref(signature: string | null | undefined, cluster: string | null | undefined): string | null {
  if (!signature || cluster === null || cluster === undefined) return null;
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}
