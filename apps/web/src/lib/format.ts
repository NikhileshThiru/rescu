const KT_TO_MPH = 1.15078;

export const mph = (kt: number) => Math.round(kt * KT_TO_MPH);

export function usd(x: number): string {
  return `$${Math.round(x).toLocaleString("en-US")}`;
}

/** $1.56B, $93.2M, $412K, $840. */
export function usdCompact(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e4) return `$${Math.round(x / 1e3)}K`;
  return usd(x);
}

export function compact(x: number): string {
  const a = Math.abs(x);
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${Math.round(x / 1e3)}K`;
  return Math.round(x).toLocaleString("en-US");
}

export const int = (x: number) => Math.round(x).toLocaleString("en-US");

export const pct = (x: number, digits = 0) => `${(100 * x).toFixed(digits)}%`;

/** Saffir-Simpson from sustained wind in kt. */
export function category(kt: number): { short: string; long: string; level: number } {
  if (kt >= 137) return { short: "Cat 5", long: "Category 5 hurricane", level: 5 };
  if (kt >= 113) return { short: "Cat 4", long: "Category 4 hurricane", level: 4 };
  if (kt >= 96) return { short: "Cat 3", long: "Category 3 hurricane", level: 3 };
  if (kt >= 83) return { short: "Cat 2", long: "Category 2 hurricane", level: 2 };
  if (kt >= 64) return { short: "Cat 1", long: "Category 1 hurricane", level: 1 };
  if (kt >= 34) return { short: "TS", long: "Tropical storm", level: 0 };
  return { short: "TD", long: "Tropical depression", level: -1 };
}

export function formatClock(unixSec: number, timeZone: string): { date: string; time: string; zone: string } {
  const d = new Date(unixSec * 1000);
  const date = d.toLocaleDateString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(d);
  const zone = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const time = parts
    .filter((p) => p.type !== "timeZoneName")
    .map((p) => p.value)
    .join("")
    .trim();
  return { date, time, zone };
}

/** "in 14 h", "9 h ago", "in 2 d 4 h". */
export function relative(deltaSec: number): string {
  const future = deltaSec > 0;
  const a = Math.abs(deltaSec);
  let s: string;
  // Round to whole hours before splitting, so 2 d 23.8 h reads "3 d 0 h", never "2 d 24 h".
  const hours = Math.round(a / 3600);
  if (a < 3600) s = `${Math.max(1, Math.round(a / 60))} min`;
  else if (hours < 48) s = `${hours} h`;
  else s = `${Math.floor(hours / 24)} d ${hours % 24} h`;
  return future ? `in ${s}` : `${s} ago`;
}

/** Plain-English name for an on-chain rule ("OverDailyCap" -> "Over $300 per 24 h"). */
export function ruleLabel(rule: string, caps?: { perOrderCapUsd: number; dailyCapUsd: number } | null): string {
  switch (rule) {
    case "ResaleBlocked":
      return "Resale to residents";
    case "NotRegisteredMerchant":
      return "Unregistered store";
    case "OverOrderCap":
      return `Over ${usd(caps?.perOrderCapUsd ?? 200)} per order`;
    case "OverDailyCap":
      return `Over ${usd(caps?.dailyCapUsd ?? 300)} per 24 h`;
    case "AidExpired":
      return "After Day 30 expiry";
    case "MerchantSuspended":
      return "Store suspended";
    case "MerchantNotApproved":
      return "Store not approved yet";
    case "AccountFrozen":
      return "Wallet frozen";
    case "OutOfZone":
      return "Outside the disaster zone";
    case "InsufficientFunds":
      return "Over the agent's allowance";
    case "NotTransferring":
      return "Not a real transfer";
    case "Unauthorized":
      return "Not the oracle";
    default:
      return rule.replace(/([a-z])([A-Z])/g, "$1 $2");
  }
}

/** "$12.99" under $10k, "$24K" above. */
export function money(x: number): string {
  return Math.abs(x) >= 1e4 ? usdCompact(x) : `$${x.toFixed(2)}`;
}
