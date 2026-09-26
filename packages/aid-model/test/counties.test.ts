import { describe, expect, it } from "vitest";
import { autoDeclareCounties, countyNeed } from "../src/index.js";

describe("auto-declaring counties", () => {
  const tracts = [
    { countyFips: "A", households: 1_000 },
    { countyFips: "A", households: 1_000 },
    { countyFips: "B", households: 10_000 },
    { countyFips: "C", households: 500 },
  ];
  const need = [0.2, 0.0, 0.01, 0.06];

  it("declares counties where the expected share needing help clears the threshold", () => {
    expect([...autoDeclareCounties(tracts, need, 0.05)].sort()).toEqual(["A", "C"]);
    expect([...autoDeclareCounties(tracts, need, 0.08)].sort()).toEqual(["A"]);
    expect([...autoDeclareCounties(tracts, need, 0.001)].sort()).toEqual(["A", "B", "C"]);
  });

  it("totals expected households in need per county", () => {
    const c = countyNeed(tracts, need);
    expect(c.get("A")).toEqual({ households: 2_000, expected: 200 });
    expect(c.get("B")!.expected).toBeCloseTo(100, 9);
  });
});
