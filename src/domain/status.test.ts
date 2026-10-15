import { describe, expect, it } from "vitest";
import { deriveStatus } from "./status";

// Literal numbers on purpose: these pin the current defaults (to confirm with
// client). If the client changes the cutoffs, update status-config.ts AND these.
describe("deriveStatus", () => {
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
  ] as const)("%i units -> %s", (balance, expected) => {
    expect(deriveStatus(balance)).toBe(expected);
  });

  it("treats a fractional value just under a cutoff as the lower level", () => {
    expect(deriveStatus(19.999)).toBe("CRITICAL");
    expect(deriveStatus(49.999)).toBe("LOW");
    expect(deriveStatus(99.999)).toBe("NORMAL");
  });
});
