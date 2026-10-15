import { describe, expect, it } from "vitest";
import type { DomainEntry } from "./ledger";
import { operatorMetric } from "./metric";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const alloc = (seq: number, effMin: number, units: number, expMin: number | null): DomainEntry => ({
  seq,
  kind: "ALLOCATION",
  units,
  effectiveAt: at(effMin),
  expiresAt: expMin === null ? null : at(expMin),
});

describe("operatorMetric", () => {
  it("is 0 units and CRITICAL for an operator with no entries", () => {
    expect(operatorMetric([], at(0))).toEqual({ activeUnits: 0, status: "CRITICAL" });
  });

  it("counts only active units and derives the status from them", () => {
    const entries = [alloc(1, 0, 60, 120), alloc(2, 10, 30, null), alloc(3, 500, 99, null)]; // last one is in the future
    expect(operatorMetric(entries, at(60))).toEqual({ activeUnits: 90, status: "NORMAL" });
    expect(operatorMetric(entries, at(120))).toEqual({ activeUnits: 30, status: "LOW" }); // first expires exactly now
  });

  it("agrees with the status cutoffs at the boundaries", () => {
    expect(operatorMetric([alloc(1, 0, 19, null)], at(1)).status).toBe("CRITICAL");
    expect(operatorMetric([alloc(1, 0, 20, null)], at(1)).status).toBe("LOW");
    expect(operatorMetric([alloc(1, 0, 100, null)], at(1)).status).toBe("HIGH");
  });
});
