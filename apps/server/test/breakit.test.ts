import { BREAK_CASES, type BreakCase } from "@rescu/live";
import { REJECTION_COPY } from "@rescu/chain";
import { describe, expect, it } from "vitest";
import { ATTACKS, excerpt, judge } from "../src/breakit/sandbox.js";

const OUT_OF_ZONE_LOGS = [
  "Program ComputeBudget111111111111111111111111111111 invoke [1]",
  "Program ComputeBudget111111111111111111111111111111 success",
  "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [1]",
  "Program log: Instruction: TransferChecked",
  "Program GrxgRShVcGaESyztvHHtaCF8YMXVhK3Wq7AesbQCaLy5 invoke [2]",
  "Program log: Instruction: TransferHook",
  "Program log: AnchorError thrown in programs/rescu/src/instructions/transfer_hook.rs:110. Error Code: OutOfZone. Error Number: 6007. Error Message: Merchant is outside this disaster zone.",
  "Program log: Left:",
  "Program log: 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  "Program log: Right:",
  "Program log: AKsmjz1DUjqJXnFJzHEoc4DQv6z9veX54SNr2L6AUTr8",
  "Program GrxgRShVcGaESyztvHHtaCF8YMXVhK3Wq7AesbQCaLy5 consumed 9001 of 290000 compute units",
  "Program GrxgRShVcGaESyztvHHtaCF8YMXVhK3Wq7AesbQCaLy5 failed: custom program error: 0x1777",
  "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb consumed 20000 of 300000 compute units",
  "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1777",
];

describe("try to break it", () => {
  it("wires an attack to every case in the catalog, and nothing else", () => {
    expect(Object.keys(ATTACKS).sort()).toEqual(BREAK_CASES.map((c) => c.id).sort());
    expect(new Set(BREAK_CASES.map((c) => c.id)).size).toBe(BREAK_CASES.length);
  });

  it("has plain-English copy for every rule a case expects", () => {
    const control = BREAK_CASES.filter((c) => c.expect === null);
    expect(control.map((c) => c.id)).toEqual(["control"]);
    for (const c of BREAK_CASES) if (c.expect) expect(REJECTION_COPY[c.expect], c.id).toBeTruthy();
  });

  it("judges a case by the rule that stopped it (or the control landing)", () => {
    const zone = BREAK_CASES.find((c) => c.id === "out_of_zone")! as BreakCase;
    const control = BREAK_CASES.find((c) => c.id === "control")! as BreakCase;
    expect(judge(zone, false, "OutOfZone")).toBe(true);
    expect(judge(zone, false, "NotRegisteredMerchant")).toBe(false);
    expect(judge(zone, true, null)).toBe(false);
    expect(judge(control, true, null)).toBe(true);
    expect(judge(control, false, "OverDailyCap")).toBe(false);
  });

  it("keeps a short log excerpt with the rule's line and without the noise", () => {
    const lines = excerpt(OUT_OF_ZONE_LOGS, "OutOfZone");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.some((l) => l.includes("Error Code: OutOfZone"))).toBe(true);
    expect(lines.some((l) => l.includes("failed: custom program error"))).toBe(true);
    expect(lines.some((l) => /Left:|Right:|ComputeBudget|consumed/.test(l))).toBe(false);
    expect(excerpt([], null)).toEqual([]);
  });
});
