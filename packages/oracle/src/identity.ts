/**
 * Duplicate identity: households that registered with the same device, phone number or street
 * address. Registrations linked by any shared value form one cluster (union-find), reported once
 * under the key that links most of it.
 */
import { clamp } from "./stats";

export type IdentityKey = "device" | "phone" | "address";
export const IDENTITY_KEYS: IdentityKey[] = ["device", "phone", "address"];

export interface IdentityRecord {
  resident: number;
  device: string;
  phone: string;
  address: string;
}

export interface IdentityCluster {
  /** Resident indices, ascending. */
  members: number[];
  /** The key that links the most members (device > phone > address on a tie). */
  key: IdentityKey;
  /** The shared value of that key (raw; mask it before showing it). */
  value: string;
  /** How many members share each key's most common value. */
  shared: Record<IdentityKey, number>;
}

export function normalize(key: IdentityKey, v: string): string {
  const s = (v ?? "").trim().toLowerCase();
  if (!s) return "";
  if (key === "phone") {
    const d = s.replace(/\D/g, "");
    return d.length >= 7 ? d.slice(-10) : "";
  }
  if (key === "address") return s.replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

export function identityClusters(records: IdentityRecord[]): IdentityCluster[] {
  const n = records.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (const key of IDENTITY_KEYS) {
    const first = new Map<string, number>();
    records.forEach((r, i) => {
      const v = normalize(key, r[key]);
      if (!v) return;
      const j = first.get(v);
      if (j === undefined) first.set(v, i);
      else union(i, j);
    });
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const out: IdentityCluster[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const shared = { device: 0, phone: 0, address: 0 } as Record<IdentityKey, number>;
    const top = { device: "", phone: "", address: "" } as Record<IdentityKey, string>;
    for (const key of IDENTITY_KEYS) {
      const counts = new Map<string, { n: number; raw: string }>();
      for (const i of rows) {
        const raw = records[i]![key];
        const v = normalize(key, raw);
        if (!v) continue;
        const c = counts.get(v) ?? { n: 0, raw };
        c.n++;
        counts.set(v, c);
      }
      for (const c of counts.values()) {
        if (c.n > shared[key]) {
          shared[key] = c.n;
          top[key] = c.raw;
        }
      }
    }
    const key = IDENTITY_KEYS.reduce((best, k) => (shared[k] > shared[best] ? k : best), "device" as IdentityKey);
    out.push({ members: rows.map((i) => records[i]!.resident).sort((a, b) => a - b), key, value: top[key], shared });
  }
  return out;
}

/** "(229) ***-**41", "dev_…9f2c", "1** Oak St, …". */
export function maskIdentity(key: IdentityKey, value: string): string {
  const v = value ?? "";
  if (key === "phone") {
    const d = v.replace(/\D/g, "").slice(-10);
    if (d.length < 4) return "***";
    return d.length === 10 ? `(${d.slice(0, 3)}) ***-**${d.slice(-2)}` : `***-**${d.slice(-2)}`;
  }
  if (key === "device") {
    const s = v.replace(/^dev_/, "");
    return `dev_…${s.slice(-4)}`;
  }
  const [street, ...rest] = v.split(",");
  const masked = (street ?? "").replace(/^(\d)(\d+)/, (_, a: string, b: string) => a + "*".repeat(b.length));
  return rest.length ? `${masked.trim()}, …` : masked.trim();
}

/** Rule score: two households on one identity ~0.72, three ~0.84, five or more ~0.95. Devices count most. */
export function duplicateScore(c: IdentityCluster): number {
  const n = c.members.length;
  const base = 0.6 + 0.12 * Math.min(3, n - 1);
  const keyBoost = c.shared.device >= 2 ? 0.04 : c.shared.phone >= 2 ? 0.02 : 0;
  const multi = IDENTITY_KEYS.filter((k) => c.shared[k] >= 2).length > 1 ? 0.03 : 0;
  return clamp(base + keyBoost + multi, 0, 0.98);
}
