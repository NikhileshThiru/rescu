import { describe, expect, it } from "vitest";
import { DEFAULT_NEED_MODEL, need } from "../src/index.js";

describe("the tuned need model shipped with the package", () => {
  const m = DEFAULT_NEED_MODEL;

  it("was trained on many storms and has sane, monotone curves", () => {
    expect(m.trainedOn.length).toBeGreaterThanOrEqual(20);
    for (const values of [m.params.windValues, m.params.rainValues]) {
      expect(values[0]).toBe(0);
      values.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(values[i]!));
    }
    expect(m.declareThreshold).toBeGreaterThan(0);
    expect(m.rainModelScale).toBeGreaterThan(0.5);
    expect(m.rainModelScale).toBeLessThan(4);
  });

  it("ranks real situations the way a disaster manager would", () => {
    const calm = need({ windKt: 20, rainIn: 1, surge: 0, mobileShare: 0.1 });
    const breezy = need({ windKt: 40, rainIn: 3, surge: 0, mobileShare: 0.1 });
    const soaked = need({ windKt: 48, rainIn: 18, surge: 0, mobileShare: 0.1 }); // Helene in upstate SC
    const eyewall = need({ windKt: 120, rainIn: 6, surge: 0, mobileShare: 0.1 }); // Keaton Beach
    const coast = need({ windKt: 105, rainIn: 12, surge: 2.5, mobileShare: 0.1 }); // Katrina, Gulfport
    expect(calm).toBe(0);
    expect(breezy).toBeLessThan(soaked);
    expect(soaked).toBeLessThan(eyewall);
    expect(eyewall).toBeLessThan(1);
    expect(coast).toBeGreaterThan(breezy * 5);
  });
});
