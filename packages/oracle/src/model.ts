/**
 * The anomaly model: an isolation forest over per-store and per-resident feature vectors, plus
 * robust z per feature so a case can show WHICH numbers are unusual. Rules open cases; the
 * forest's score raises (never lowers) how confident the oracle is.
 */
import type { Feature, Severity } from "@rescu/live";
import { type ForestOptions, IsolationForest } from "./forest";
import { clamp01, type RobustStats, robustStats, robustZ, round } from "./stats";

export interface FeatureSpec {
  name: string;
  label: string;
}

export const STORE_FEATURES: FeatureSpec[] = [
  { name: "max_markup", label: "Highest price vs regional median (x)" },
  { name: "items_marked_up", label: "Items priced past the gouging line" },
  { name: "log_takings", label: "Relief takings (log $)" },
  { name: "top_customer_share", label: "Takings from its top 3 customers" },
  { name: "refused_rate", label: "Payments refused by the chain" },
  { name: "avg_sale", label: "Average sale ($)" },
];

export const RESIDENT_FEATURES: FeatureSpec[] = [
  { name: "orders_per_day", label: "Orders per day since aid landed" },
  { name: "cap_hits", label: "Payments refused for a cap" },
  { name: "spent_48h", label: "Aid spent in the first 48 h" },
  { name: "top_store_share", label: "Spending at one store" },
  { name: "identity_links", label: "Other households on the same ID" },
  { name: "avg_order_share", label: "Average order, share of aid" },
];

export class FeatureModel {
  readonly forest: IsolationForest;
  private stats: RobustStats[] = [];

  constructor(
    readonly specs: FeatureSpec[],
    opts: ForestOptions = {},
  ) {
    this.forest = new IsolationForest(opts);
  }

  get trainedOn() {
    return this.forest.trainedOn;
  }

  /** Fits the forest and the per-feature baselines on the population. */
  fit(rows: number[][]): this {
    this.forest.fit(rows);
    this.stats = this.specs.map((_, f) => robustStats(rows.map((r) => r[f]!)));
    return this;
  }

  /** Raw isolation-forest score, 0-1 (0.5 ordinary, near 1 isolated at once). */
  anomaly(row: number[]): number {
    return this.forest.fitted ? this.forest.score(row) : 0;
  }

  /** The row as named features with robust z against the population. */
  features(row: number[], floors: number[] = []): Feature[] {
    return this.specs.map((s, f) => ({
      name: s.name,
      label: s.label,
      value: round(row[f] ?? 0, 3),
      z: this.stats[f] ? round(robustZ(row[f] ?? 0, this.stats[f]!, floors[f] ?? 0.05), 2) : 0,
    }));
  }
}

/** Maps the forest's score onto 0-1 confidence: 0.5 (ordinary) -> 0, 0.75 and up -> 1. */
export const calibrateAnomaly = (a: number) => clamp01((a - 0.5) / 0.25);

/** Case score: the rule's own score, raised (never lowered) by a strong anomaly. */
export function combineScore(rule: number, anomaly: number | null): number {
  if (anomaly === null) return round(rule, 3);
  return round(Math.max(rule, 0.5 * rule + 0.5 * calibrateAnomaly(anomaly)), 3);
}

export function severityOf(score: number): Severity {
  return score >= 0.8 ? "high" : score >= 0.65 ? "medium" : "low";
}
