import { describe, expect, it } from "vitest";
import { computeExpiresAt } from "./expiry";

const at = new Date("2026-01-01T12:00:00.000Z");

describe("computeExpiresAt", () => {
  it("adds the tier's minutes to effectiveAt", () => {
    expect(computeExpiresAt(at, 2)).toEqual(new Date("2026-01-01T12:02:00.000Z"));
    expect(computeExpiresAt(at, 24 * 60)).toEqual(new Date("2026-01-02T12:00:00.000Z"));
    expect(computeExpiresAt(at, 72 * 60)).toEqual(new Date("2026-01-04T12:00:00.000Z"));
  });

  it("returns null when the tier never expires", () => {
    expect(computeExpiresAt(at, null)).toBeNull();
  });

  it("0 minutes expires at the moment it takes effect (never active)", () => {
    expect(computeExpiresAt(at, 0)).toEqual(at);
  });

  it("does not mutate its input and returns a new Date", () => {
    const result = computeExpiresAt(at, 5);
    expect(at.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    expect(result).not.toBe(at);
  });

  it("rejects a negative or non-finite tier expiry instead of producing a date in the past", () => {
    expect(() => computeExpiresAt(at, -1)).toThrow(RangeError);
    expect(() => computeExpiresAt(at, Number.NaN)).toThrow(RangeError);
    expect(() => computeExpiresAt(at, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
