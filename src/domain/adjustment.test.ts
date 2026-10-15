import { describe, expect, it } from "vitest";
import { addedActiveUnits, adjustBodySchema, adjustInputSchema, buildAdjustment } from "./adjustment";

const T = (iso: string) => new Date(iso);

describe("adjustInputSchema", () => {
  const valid = { supervisorId: "sup_1", targetSeq: 12, units: -5, reason: "Miscount at pickup", idempotencyKey: "k-1" };

  it("accepts a valid request, positive or negative", () => {
    expect(adjustInputSchema.parse(valid)).toEqual(valid);
    expect(adjustInputSchema.parse({ ...valid, units: 7 }).units).toBe(7);
  });

  it("trims the reason", () => {
    expect(adjustInputSchema.parse({ ...valid, reason: "  typo  " }).reason).toBe("typo");
  });

  it.each([
    ["zero units", { ...valid, units: 0 }],
    ["fractional units", { ...valid, units: 1.5 }],
    ["missing reason", { ...valid, reason: undefined }],
    ["empty reason", { ...valid, reason: "" }],
    ["whitespace-only reason", { ...valid, reason: "   " }],
    ["over-long reason", { ...valid, reason: "r".repeat(501) }],
    ["zero targetSeq", { ...valid, targetSeq: 0 }],
    ["negative targetSeq", { ...valid, targetSeq: -1 }],
    ["fractional targetSeq", { ...valid, targetSeq: 1.5 }],
    ["missing targetSeq", { ...valid, targetSeq: undefined }],
    ["empty supervisorId", { ...valid, supervisorId: "" }],
    ["empty idempotency key", { ...valid, idempotencyKey: "" }],
    ["over-long idempotency key", { ...valid, idempotencyKey: "k".repeat(201) }],
  ])("rejects %s", (_name, input) => {
    expect(adjustInputSchema.safeParse(input).success).toBe(false);
  });

  it("rejects fields the server owns: effectiveAt, expiresAt, operatorId (all come from the target)", () => {
    for (const extra of [{ effectiveAt: "2020-01-01T00:00:00Z" }, { expiresAt: null }, { operatorId: "op_9" }]) {
      expect(adjustInputSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });
});

describe("buildAdjustment", () => {
  const target = {
    seq: 12,
    kind: "ALLOCATION",
    operatorId: "op_1",
    poolId: "pool_1",
    effectiveAt: T("2026-03-01T09:00:00.000Z"),
    expiresAt: T("2026-03-02T09:00:00.000Z"),
  } as const;
  const input = { supervisorId: "sup_1", targetSeq: 12, units: -5, reason: "Miscount", idempotencyKey: "k-1" };

  it("points at the target and copies its operator, pool, effectiveAt and expiresAt", () => {
    expect(buildAdjustment(target, input)).toEqual({
      kind: "ADJUSTMENT",
      operatorId: "op_1",
      poolId: "pool_1",
      createdById: "sup_1",
      units: -5,
      effectiveAt: target.effectiveAt,
      expiresAt: target.expiresAt,
      refSeq: 12,
      reason: "Miscount",
      idempotencyKey: "k-1",
    });
  });

  it("copies a never-expiring target as expiresAt null", () => {
    expect(buildAdjustment({ ...target, expiresAt: null }, input).expiresAt).toBeNull();
  });

  it("returns its own Date objects, so mutating them can't alter the target", () => {
    const built = buildAdjustment(target, input);
    expect(built.effectiveAt).not.toBe(target.effectiveAt);
    expect(built.expiresAt).not.toBe(target.expiresAt);
    built.effectiveAt.setUTCFullYear(1999);
    expect(target.effectiveAt.toISOString()).toBe("2026-03-01T09:00:00.000Z");
  });
});

describe("addedActiveUnits: how many ACTIVE units an adjustment would add right now (for the capacity check)", () => {
  const now = T("2026-03-01T12:00:00.000Z");
  const past = T("2026-03-01T09:00:00.000Z");

  it("a positive adjustment on a live target adds its units", () => {
    expect(addedActiveUnits({ units: 8, effectiveAt: past, expiresAt: T("2026-03-02T09:00:00.000Z") }, now)).toBe(8);
  });

  it("a positive adjustment on a never-expiring target adds its units", () => {
    expect(addedActiveUnits({ units: 8, effectiveAt: past, expiresAt: null }, now)).toBe(8);
  });

  it("adds nothing when the target has already expired (the adjustment expires with it)", () => {
    expect(addedActiveUnits({ units: 8, effectiveAt: past, expiresAt: T("2026-03-01T10:00:00.000Z") }, now)).toBe(0);
  });

  it("adds nothing when the target expires exactly now (boundary: already gone)", () => {
    expect(addedActiveUnits({ units: 8, effectiveAt: past, expiresAt: now }, now)).toBe(0);
  });

  it("still adds its units 1ms before the target expires", () => {
    expect(addedActiveUnits({ units: 8, effectiveAt: past, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(8);
  });

  it("a negative adjustment never adds capacity usage", () => {
    expect(addedActiveUnits({ units: -8, effectiveAt: past, expiresAt: null }, now)).toBe(0);
  });
});

describe("adjustBodySchema (HTTP body: the supervisor and the idempotency key come from the cookie and header)", () => {
  const body = { targetSeq: 12, units: -5, reason: "Miscount" };

  it("accepts targetSeq, units and reason", () => {
    expect(adjustBodySchema.parse(body)).toEqual(body);
  });

  it.each([
    ["missing reason", { ...body, reason: undefined }],
    ["blank reason", { ...body, reason: "  " }],
    ["zero units", { ...body, units: 0 }],
    ["supervisorId in the body", { ...body, supervisorId: "sup_2" }],
    ["idempotencyKey in the body", { ...body, idempotencyKey: "k" }],
    ["effectiveAt in the body", { ...body, effectiveAt: "2020-01-01T00:00:00Z" }],
  ])("rejects %s", (_name, input) => {
    expect(adjustBodySchema.safeParse(input).success).toBe(false);
  });
});
