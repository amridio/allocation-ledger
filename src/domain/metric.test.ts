import { describe, expect, it } from "vitest";
import type { DomainEntry } from "./ledger";
import { applyPendingUnits, nextExpiryAt, operatorMetric } from "./metric";

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

describe("nextExpiryAt: when the operator's active units next change because something expires", () => {
  it("is null with no entries, and null when nothing active will ever expire", () => {
    expect(nextExpiryAt([], at(0))).toBeNull();
    expect(nextExpiryAt([alloc(1, 0, 50, null)], at(10))).toBeNull();
  });

  it("is the earliest expiry among the entries that are active now", () => {
    const entries = [alloc(1, 0, 10, 300), alloc(2, 0, 10, 120), alloc(3, 0, 10, null), alloc(4, 0, 10, 200)];
    expect(nextExpiryAt(entries, at(60))).toEqual(at(120));
  });

  it("an entry expiring exactly now is already expired, so it isn't 'next'", () => {
    const entries = [alloc(1, 0, 10, 60), alloc(2, 0, 10, 90)];
    expect(nextExpiryAt(entries, at(60))).toEqual(at(90));
  });

  it("1ms before an expiry, that expiry is still next", () => {
    expect(nextExpiryAt([alloc(1, 0, 10, 60)], new Date(at(60).getTime() - 1))).toEqual(at(60));
  });

  it("ignores entries that already expired and entries that haven't taken effect yet", () => {
    const entries = [alloc(1, 0, 10, 30), alloc(2, 500, 10, 600), alloc(3, 0, 10, 200)];
    expect(nextExpiryAt(entries, at(60))).toEqual(at(200));
  });

  it("an adjustment that expires with its target gives the same instant", () => {
    const entries: DomainEntry[] = [
      alloc(1, 0, 30, 120),
      { seq: 2, kind: "ADJUSTMENT", units: -5, effectiveAt: at(0), expiresAt: at(120), refSeq: 1 },
    ];
    expect(nextExpiryAt(entries, at(10))).toEqual(at(120));
  });
});

describe("applyPendingUnits: the optimistic metric while allocations are still being sent", () => {
  const base = { activeUnits: 10, status: "CRITICAL" } as const;

  it("is unchanged with nothing pending", () => {
    expect(applyPendingUnits(base, [])).toEqual(base);
  });

  it("adds the pending units and re-derives the status with the same cutoffs as the server", () => {
    expect(applyPendingUnits(base, [10])).toEqual({ activeUnits: 20, status: "LOW" });
    expect(applyPendingUnits(base, [20, 20])).toEqual({ activeUnits: 50, status: "NORMAL" });
    expect(applyPendingUnits(base, [90])).toEqual({ activeUnits: 100, status: "HIGH" });
  });

  it("does not trust the base status: it is recomputed from the total", () => {
    expect(applyPendingUnits({ activeUnits: 19, status: "HIGH" }, [1]).status).toBe("LOW");
  });
});
