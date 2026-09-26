/** Money in the resident app is integer cents on the wire. */
export function cents(c: number): string {
  return (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "$2,000" for round amounts, "$1,972.13" otherwise. */
export function centsShort(c: number): string {
  return c % 100 === 0 ? (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : cents(c);
}

export function km(d: number | null | undefined): string {
  if (d === null || d === undefined) return "";
  if (d < 1) return "under 1 km";
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} km`;
}

export function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function simClock(t: number, timeZone = "America/New_York"): string {
  return new Date(t * 1000).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/, "");
}

export function simDay(t: number, timeZone = "America/New_York"): string {
  return new Date(t * 1000).toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
}

/** "in 3 h", "in 40 min". */
export function until(deltaSec: number): string {
  const a = Math.max(0, deltaSec);
  if (a < 3600) return `${Math.max(1, Math.round(a / 60))} min`;
  const h = Math.round(a / 3600);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** The headline for a payment the chain refused. */
export function blockedHeadline(rule: string | null, message: string | null): string {
  if (rule === "MerchantSuspended") return "Blocked on-chain · the oracle suspended this merchant";
  if (rule === "AccountFrozen") return "Blocked on-chain · the oracle froze this wallet";
  if (message) return `Blocked on-chain · ${message.replace(/^Blocked:\s*/i, "").replace(/\.$/, "")}`;
  return "Blocked on-chain";
}
