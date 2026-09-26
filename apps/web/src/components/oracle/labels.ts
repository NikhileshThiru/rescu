import type { CaseKind, CaseStatus, OracleCase } from "@rescu/live";

export const KIND_LABEL: Record<CaseKind, string> = {
  gouging: "Price gouging",
  duplicate_identity: "Duplicate identity",
  velocity: "Spending speed",
  collusion: "Aid for cash",
};

export const KIND_SHORT: Record<CaseKind, string> = {
  gouging: "Gouging",
  duplicate_identity: "Identity",
  velocity: "Velocity",
  collusion: "Collusion",
};

/** Amber = flagged and waiting, red = acted on (the chain refuses them now), neutral = dismissed. */
export function caseTone(c: Pick<OracleCase, "status">): "amber" | "red" | "neutral" {
  return c.status === "open" ? "amber" : c.status === "actioned" ? "red" : "neutral";
}

export const STATUS_LABEL: Record<CaseStatus, string> = {
  open: "Open",
  actioned: "Actioned on-chain",
  dismissed: "Dismissed",
};

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export const pct = (x: number | null | undefined, d = 0) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(d)}%`);
