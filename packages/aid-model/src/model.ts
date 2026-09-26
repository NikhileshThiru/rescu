import type { HazardInput, NeedParams } from "./need.js";
import { needProbability } from "./need.js";
import fitted from "./need-model.json" with { type: "json" };

/** The need model tuned on FEMA outcomes by data/pipeline/fit.ts (regenerate with `pnpm data:fit`). */
export interface NeedModel {
  fittedAt: string;
  trainedOn: string[];
  params: NeedParams;
  /** Multiply R-CLIPER rain by this for storms without rain observations (drawn storms). */
  rainModelScale: number;
  /** Declare a county when the model expects at least this share of its households to need help. */
  declareThreshold: number;
}

export const DEFAULT_NEED_MODEL: NeedModel = fitted as unknown as NeedModel;

/** Need (0 to 1) for one tract under the tuned model. */
export function need(h: HazardInput, model: NeedModel = DEFAULT_NEED_MODEL): number {
  return needProbability(h, model.params);
}
