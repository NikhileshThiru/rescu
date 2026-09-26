/**
 * The oracle: watches every price and payment for gouging and fraud, opens cases with evidence
 * and a Grok write-up, and acts on-chain (suspend a store, freeze a wallet). Afterwards the chain
 * itself turns them away.
 */
import { z } from "zod";

export type CaseKind = "gouging" | "duplicate_identity" | "velocity" | "collusion";
export type CaseStatus = "open" | "actioned" | "dismissed";
export type Severity = "low" | "medium" | "high";

export type SubjectRef = { kind: "merchant"; idx: number; name: string } | { kind: "resident"; idx: number; name: string };

export type OracleActionKind = "suspend_merchant" | "reinstate_merchant" | "freeze_wallet" | "unfreeze_wallet" | "dismiss" | "reopen";

export const ActionInput = z.object({
  kind: z.enum(["suspend_merchant", "reinstate_merchant", "freeze_wallet", "unfreeze_wallet", "dismiss", "reopen"]),
  /** Which subject (defaults to every subject of the right kind on the case). */
  target: z.number().int().min(0).optional(),
});
export type ActionInput = z.infer<typeof ActionInput>;

export interface OracleActionRecord {
  kind: OracleActionKind;
  target: SubjectRef | null;
  /** Wall ms. */
  at: number;
  simT: number;
  ok: boolean;
  /** The on-chain transaction (set_merchant_status / set_wallet_frozen), signed by the oracle key. */
  signature: string | null;
  error: string | null;
  by: "presenter" | "auto";
}

/** One feature behind the anomaly score, with how unusual it is (robust z: median/MAD). */
export interface Feature {
  name: string;
  value: number;
  /** Plain label with units: "Water price vs regional median". */
  label: string;
  z: number;
}

export type Evidence =
  | {
      kind: "gouging";
      itemId: number;
      item: string;
      priceCents: number;
      /** Pre-storm regional median for the item (same category, nearby stores). */
      medianCents: number;
      /** priceCents / medianCents. */
      ratio: number;
      thresholdPct: number;
      /** Landed sales at the gouged price, and how much residents overpaid in total. */
      sales: number;
      overchargeCents: number;
      /** The store's price over sim time (steps). */
      series: { simT: number; priceCents: number }[];
      /** What nearby stores charge for the same item right now. */
      peers: { store: number; name: string; priceCents: number; distanceKm: number }[];
      /** Other items this store also marked up past the threshold. */
      otherItems: { itemId: number; item: string; ratio: number }[];
    }
  | {
      kind: "duplicate_identity";
      key: "device" | "phone" | "address";
      /** Masked, e.g. "(229) ***-**41" or "dev_…9f2c". */
      value: string;
      households: { resident: number; name: string; county: string; aidCents: number; registeredAt: number }[];
      /** Aid paid to the extra registrations (everyone after the first). */
      duplicateAidCents: number;
    }
  | {
      kind: "velocity";
      resident: number;
      orders: number;
      /** Payments the chain turned away for a cap (OverDailyCap / OverOrderCap). */
      capHits: number;
      spentCents: number;
      aidCents: number;
      /** Sim hours from aid landing to the latest order. */
      hours: number;
      timeline: { simT: number; cents: number; ok: boolean; rule: string | null }[];
    }
  | {
      kind: "collusion";
      merchant: number;
      merchantName: string;
      /** Residents who spent nearly all of their aid at this one store. */
      residents: { resident: number; name: string; spentCents: number; shareAtStore: number }[];
      storeVolumeCents: number;
      /** What a store of this category and neighbourhood normally takes in. */
      expectedVolumeCents: number;
      /** Share of the store's volume that came from those residents. */
      concentration: number;
    };

export interface OracleCase {
  id: string;
  runId: string;
  kind: CaseKind;
  status: CaseStatus;
  /** 0-1: rules and the isolation-forest anomaly score combined. */
  score: number;
  severity: Severity;
  /** "Riverside Grocery charging 4.1x for bottled water". */
  title: string;
  subjects: SubjectRef[];
  /** Wall ms. */
  openedAt: number;
  updatedAt: number;
  /** Sim time the case opened. */
  simT: number;
  evidence: Evidence;
  features: Feature[];
  /** The model's own anomaly score for the subject (isolation forest, 0-1; higher = stranger), null for rule-only cases. */
  anomaly: number | null;
  summary: { status: "pending" | "ready" | "fallback" | "error"; text: string | null; model: string | null };
  /** What the oracle suggests doing. */
  recommended: OracleActionKind[];
  actions: OracleActionRecord[];
}

export type PlantedKind = "gouging" | "duplicate_identity" | "velocity" | "collusion";

export interface OracleMetrics {
  runId: string;
  scans: number;
  /** How long the last full scan took, ms. */
  lastScanMs: number;
  lastScanAt: number;
  thresholds: { gougePct: number; scoreToOpen: number };
  cases: { kind: CaseKind; open: number; actioned: number; dismissed: number }[];
  /** Ground truth from the sim's planted bad actors (for the judges' "did it catch them" panel). */
  planted: { kind: PlantedKind; total: number; caught: number }[];
  /** Over cases opened: share that name a planted bad actor (null before any case). */
  precision: number | null;
  /** Over planted bad actors that have acted so far: share caught (null before any acted). */
  recall: number | null;
  model: { name: string; trees: number; sampleSize: number; features: string[]; trainedOn: number } | null;
  grok: { summaries: number; usd: number; spentUsd: number; limitUsd: number };
}

/** A store's oracle state, for map dots and store lists. */
export interface StoreState {
  idx: number;
  status: "pending" | "approved" | "suspended";
  flagged: boolean;
  /** The open case that flags it. */
  caseId: string | null;
}
