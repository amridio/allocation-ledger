import { describe, expect, it } from "vitest";
import { allocateBodySchema, allocateInputSchema, fitsCapacity, isSamePayload } from "./allocation";

describe("allocateInputSchema", () => {
  const valid = { operatorId: "op_1", units: 25, idempotencyKey: "k-1" };

  it("accepts a valid request", () => {
    expect(allocateInputSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ["zero units", { ...valid, units: 0 }],
    ["negative units", { ...valid, units: -5 }],
    ["fractional units", { ...valid, units: 2.5 }],
    ["string units", { ...valid, units: "25" }],
    ["missing idempotency key", { operatorId: "op_1", units: 25 }],
    ["empty idempotency key", { ...valid, idempotencyKey: "" }],
    ["over-long idempotency key", { ...valid, idempotencyKey: "k".repeat(201) }],
    ["empty operator id", { ...valid, operatorId: "" }],
  ])("rejects %s", (_name, input) => {
    expect(allocateInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects fields the server owns, such as effectiveAt, so a client can't backdate", () => {
    expect(allocateInputSchema.safeParse({ ...valid, effectiveAt: "2020-01-01T00:00:00Z" }).success).toBe(false);
    expect(allocateInputSchema.safeParse({ ...valid, expiresAt: null }).success).toBe(false);
  });
});

describe("isSamePayload (idempotent retry check)", () => {
  const base = { operatorId: "op_1", kind: "ALLOCATION", units: 25, refSeq: null } as const;

  it("is true for an identical payload", () => {
    expect(isSamePayload(base, { ...base })).toBe(true);
  });

  it("ignores everything else, notably effectiveAt: the server sets it, so a real retry always differs", () => {
    const stored = { ...base, effectiveAt: new Date("2026-01-01T12:00:00Z"), recordedAt: new Date(), seq: 7 };
    const retry = { ...base, effectiveAt: new Date("2026-01-01T12:00:09Z"), recordedAt: new Date(), seq: 99 };
    expect(isSamePayload(stored, retry)).toBe(true);
  });

  it.each([
    ["operator", { ...base, operatorId: "op_2" }],
    ["kind", { ...base, kind: "ADJUSTMENT" }],
    ["units", { ...base, units: 26 }],
    ["refSeq", { ...base, refSeq: 3 }],
  ] as const)("is false when the %s differs", (_name, other) => {
    expect(isSamePayload(base, other)).toBe(false);
  });

  it("compares refSeq for adjustments", () => {
    const adjustment = { operatorId: "op_1", kind: "ADJUSTMENT", units: -5, refSeq: 3 } as const;
    expect(isSamePayload(adjustment, { ...adjustment })).toBe(true);
    expect(isSamePayload(adjustment, { ...adjustment, refSeq: 4 })).toBe(false);
  });
});

describe("fitsCapacity", () => {
  it("always fits when the pool has no capacity limit (null)", () => {
    expect(fitsCapacity({ capacity: null, activeUnits: 1_000_000, units: 1_000_000 })).toBe(true);
  });

  it("fits when the result is exactly at capacity", () => {
    expect(fitsCapacity({ capacity: 100, activeUnits: 90, units: 10 })).toBe(true);
  });

  it("does not fit when one unit over", () => {
    expect(fitsCapacity({ capacity: 100, activeUnits: 90, units: 11 })).toBe(false);
  });

  it("a capacity of 0 fits nothing", () => {
    expect(fitsCapacity({ capacity: 0, activeUnits: 0, units: 1 })).toBe(false);
  });

  it("does not fit when the pool is already over capacity (e.g. the limit was lowered)", () => {
    expect(fitsCapacity({ capacity: 50, activeUnits: 80, units: 1 })).toBe(false);
  });
});

describe("allocateBodySchema (HTTP body: the operator and the idempotency key come from the cookie and header)", () => {
  it("accepts just units", () => {
    expect(allocateBodySchema.parse({ units: 25 })).toEqual({ units: 25 });
  });

  it.each([
    ["zero units", { units: 0 }],
    ["negative units", { units: -1 }],
    ["fractional units", { units: 1.5 }],
    ["missing units", {}],
    ["operatorId in the body (comes from the cookie)", { units: 5, operatorId: "op_2" }],
    ["idempotencyKey in the body (comes from the header)", { units: 5, idempotencyKey: "k" }],
    ["effectiveAt in the body", { units: 5, effectiveAt: "2020-01-01T00:00:00Z" }],
  ])("rejects %s", (_name, input) => {
    expect(allocateBodySchema.safeParse(input).success).toBe(false);
  });
});
