import { describe, expect, it } from "vitest";
import { statusForActiveUnits } from "./status";

// Literal numbers on purpose: these pin the current defaults (to confirm with
// client). If the client changes the cutoffs, update status-config.ts AND these.
describe("statusForActiveUnits", () => {
  it.each([
    [-5, "CRITICAL"],
    [0, "CRITICAL"],
    [19, "CRITICAL"],
    [20, "LOW"],
    [49, "LOW"],
    [50, "NORMAL"],
    [99, "NORMAL"],
    [100, "HIGH"],
    [5000, "HIGH"],
  ] as const)("%i units -> %s", (units, expected) => {
    expect(statusForActiveUnits(units)).toBe(expected);
  });
});
