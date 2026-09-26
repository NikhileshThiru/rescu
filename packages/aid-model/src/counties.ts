import type { Impact } from "./types.js";

export interface CountyTract {
  countyFips: string;
  households: number;
}

export interface AutoDeclareRule {
  /** Declare a county if at least this share of its households saw >= 50 kt... */
  minShareAt50kt: number;
  /** ...or any of its tracts saw hurricane-force (64 kt) winds. */
  anyAt64kt: boolean;
}

export const DEFAULT_AUTO_DECLARE: AutoDeclareRule = { minShareAt50kt: 0.1, anyAt64kt: true };

/**
 * Stand-in for a FEMA designation when there isn't one (custom storms): counties where the
 * storm plainly did damage. The Declare screen can add or remove counties by hand.
 */
export function autoDeclareCounties(
  tracts: CountyTract[],
  impacts: Impact[],
  rule: AutoDeclareRule = DEFAULT_AUTO_DECLARE,
): Set<string> {
  const stats = new Map<string, { hh: number; hh50: number; any64: boolean }>();
  tracts.forEach((t, i) => {
    const imp = impacts[i]!;
    let s = stats.get(t.countyFips);
    if (!s) {
      s = { hh: 0, hh50: 0, any64: false };
      stats.set(t.countyFips, s);
    }
    s.hh += t.households;
    if (imp.maxKt >= 50) s.hh50 += t.households;
    if (imp.maxKt >= 64) s.any64 = true;
  });
  const out = new Set<string>();
  for (const [county, s] of stats) {
    if ((rule.anyAt64kt && s.any64) || (s.hh > 0 && s.hh50 / s.hh >= rule.minShareAt50kt)) out.add(county);
  }
  return out;
}
