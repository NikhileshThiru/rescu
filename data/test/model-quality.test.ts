/**
 * Guards the tuned need model's real-world quality. Reads the committed model and its
 * leave-one-storm-out results (packages/aid-model/src/need-model.json, written by data:fit),
 * so a refit that quietly gets worse fails the build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const model = JSON.parse(readFileSync(new URL("../../packages/aid-model/src/need-model.json", import.meta.url), "utf8"));
type Scores = Record<"hazard" | "specRule" | "modeledRain", { overlap: number }>;
const held = Object.entries(model.validation as Record<string, { scores: Scores; declare: { captureOfFemaHouseholds: number } }>);

describe("need model vs. FEMA's real outcomes (storms held out of training)", () => {
  it("was tested on every training storm, not just the demo ones", () => {
    expect(held.length).toBe(model.trainedOn.length);
    expect(held.length).toBeGreaterThanOrEqual(20);
  });

  it("splits need across counties more like FEMA than the spec's wind-band rule, almost always", () => {
    const wins = held.filter(([, v]) => v.scores.hazard.overlap > v.scores.specRule.overlap).length;
    expect(wins / held.length).toBeGreaterThanOrEqual(0.85);
    expect(model.overall.hazard.median).toBeGreaterThan(model.overall.specRule.median + 0.15);
    expect(model.overall.hazard.median).toBeGreaterThanOrEqual(0.55);
  });

  it("beats the spec rule on each demo storm", () => {
    for (const slug of ["helene-2024", "ian-2022", "katrina-2005"]) {
      const v = Object.fromEntries(held)[slug]!;
      expect(v.scores.hazard.overlap, slug).toBeGreaterThan(v.scores.specRule.overlap);
    }
  });

  it("declares, at landfall, the counties where most of FEMA's approved households turned out to be", () => {
    const capture = held.map(([, v]) => v.declare.captureOfFemaHouseholds).sort((a, b) => a - b);
    expect(capture[Math.floor(capture.length / 2)]!).toBeGreaterThanOrEqual(0.9);
  });

  it("still works for a drawn storm (rain model instead of rain observations)", () => {
    expect(model.overall.modeledRain.median).toBeGreaterThan(model.overall.specRule.median + 0.1);
  });
});
