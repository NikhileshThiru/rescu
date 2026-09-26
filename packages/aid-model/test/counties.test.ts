import { describe, expect, it } from "vitest";
import { autoDeclareCounties, type Band, type Impact } from "../src/index.js";

const imp = (maxKt: number): Impact => ({ maxKt, band: 0 as Band, peakT: null, t34: null, t50: null, t64: null });

describe("auto-declaring counties (custom storms)", () => {
  it("declares counties with hurricane-force wind or a real share of households at 50 kt", () => {
    const tracts = [
      { countyFips: "A", households: 1_000 }, { countyFips: "A", households: 9_000 }, // 10% at 50 kt
      { countyFips: "B", households: 100 }, { countyFips: "B", households: 50_000 }, // one tract at 64 kt
      { countyFips: "C", households: 1_000 }, { countyFips: "C", households: 99_000 }, // 1% at 50 kt
    ];
    const set = autoDeclareCounties(tracts, [imp(55), imp(30), imp(70), imp(20), imp(52), imp(40)]);
    expect([...set].sort()).toEqual(["A", "B"]);
  });
});
