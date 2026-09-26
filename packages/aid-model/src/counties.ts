export interface CountyTract {
  countyFips: string;
  households: number;
}

/**
 * Declares counties from the storm itself at landfall: a county is in when the model expects
 * at least `minShare` of its households to need help. The threshold is tuned against FEMA's
 * designations on past storms; officials can still add or remove counties by hand.
 */
export function autoDeclareCounties(tracts: CountyTract[], need: ArrayLike<number>, minShare: number): Set<string> {
  const stats = new Map<string, { hh: number; expected: number }>();
  tracts.forEach((t, i) => {
    let s = stats.get(t.countyFips);
    if (!s) {
      s = { hh: 0, expected: 0 };
      stats.set(t.countyFips, s);
    }
    s.hh += t.households;
    s.expected += t.households * need[i]!;
  });
  const out = new Set<string>();
  for (const [county, s] of stats) if (s.hh > 0 && s.expected / s.hh >= minShare) out.add(county);
  return out;
}

/** Expected households needing help per county. */
export function countyNeed(tracts: CountyTract[], need: ArrayLike<number>): Map<string, { households: number; expected: number }> {
  const out = new Map<string, { households: number; expected: number }>();
  tracts.forEach((t, i) => {
    const s = out.get(t.countyFips) ?? { households: 0, expected: 0 };
    s.households += t.households;
    s.expected += t.households * need[i]!;
    out.set(t.countyFips, s);
  });
  return out;
}
