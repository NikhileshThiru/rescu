/**
 * The need model: what share of households in a tract will need help, given what hit it.
 *
 *   hazard rate  = wind(V) x (1 + mobile x mobile-home share) + rain(R) + surge x S
 *                  + windRain x soaked(V, R)
 *   need         = 1 - exp(-hazard rate)          (a probability, 0 to 1)
 *
 * soaked() is the "trees on houses" term: moderate wind on rain-saturated ground topples trees
 * onto roofs and power lines (Helene across upstate South Carolina and Augusta).
 *
 * wind() and rain() are non-decreasing piecewise-linear curves. Every weight is tuned on what FEMA
 * actually approved for households after past hurricanes (see calibrate.ts). Vulnerability (SVI)
 * is deliberately NOT here: it's a policy choice applied in the allocation, not learned from
 * FEMA, whose payouts favour better-off homeowners.
 */

export interface HazardInput {
  /** Peak sustained wind, kt. */
  windKt: number;
  /** Storm-total rain, inches. */
  rainIn: number;
  /** Surge index (surge.ts). */
  surge: number;
  /** Share of homes that are mobile homes, 0 to 1. */
  mobileShare: number;
}

export interface NeedParams {
  /** Wind curve knots (kt); the curve is 0 at the first knot and below. */
  windKnots: number[];
  /** Hazard-rate value at each wind knot (first is 0, non-decreasing). */
  windValues: number[];
  rainKnots: number[];
  rainValues: number[];
  surge: number;
  /** Extra wind damage per unit mobile-home share. */
  mobile: number;
  /** Weight of the wind-on-saturated-ground interaction. */
  windRain: number;
}

export const WIND_KNOTS = [25, 34, 50, 64, 83, 96, 113, 137];
export const RAIN_KNOTS = [2, 4, 6, 8, 10, 15, 20, 30];

/** Piecewise-linear, flat below the first and above the last knot. */
export function curve(x: number, knots: number[], values: number[]): number {
  if (x <= knots[0]!) return values[0]!;
  for (let i = 1; i < knots.length; i++) {
    if (x <= knots[i]!) {
      const f = (x - knots[i - 1]!) / (knots[i]! - knots[i - 1]!);
      return values[i - 1]! + f * (values[i]! - values[i - 1]!);
    }
  }
  return values[values.length - 1]!;
}

/** Wind above tropical-storm force on soaked ground: 0 when calm or dry, up to 6. */
export function soaked(windKt: number, rainIn: number): number {
  return Math.min(2, Math.max(0, (windKt - 30) / 40)) * Math.min(3, Math.max(0, rainIn / 10));
}

export function hazardRate(h: HazardInput, p: NeedParams): number {
  const wind = curve(h.windKt, p.windKnots, p.windValues) * (1 + p.mobile * h.mobileShare);
  return wind + curve(h.rainIn, p.rainKnots, p.rainValues) + p.surge * h.surge + p.windRain * soaked(h.windKt, h.rainIn);
}

/** Expected share of households needing help (0 to 1). */
export function needProbability(h: HazardInput, p: NeedParams): number {
  return 1 - Math.exp(-hazardRate(h, p));
}

/** Which hazard contributes most to a tract's need (for the map legend and receipts). */
export function dominantHazard(h: HazardInput, p: NeedParams): "wind" | "rain" | "surge" | "none" {
  const interaction = p.windRain * soaked(h.windKt, h.rainIn);
  const parts = {
    // The wind-on-soaked-ground term is split evenly between the two hazards that cause it.
    wind: curve(h.windKt, p.windKnots, p.windValues) * (1 + p.mobile * h.mobileShare) + interaction / 2,
    rain: curve(h.rainIn, p.rainKnots, p.rainValues) + interaction / 2,
    surge: p.surge * h.surge,
  };
  const [name, value] = Object.entries(parts).sort((a, b) => b[1] - a[1])[0]!;
  return value > 0 ? (name as "wind" | "rain" | "surge") : "none";
}
