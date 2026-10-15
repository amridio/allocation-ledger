import { describe, expect, it } from "vitest";
import { computeExpiresAt } from "./expiry";

const at = new Date("2026-01-01T12:00:00.000Z");

describe("computeExpiresAt", () => {
  it("adds the tier's minutes to effectiveAt", () => {
    expect(computeExpiresAt(at, 2)).toEqual(new Date("2026-01-01T12:02:00.000Z"));
    expect(computeExpiresAt(at, 24 * 60)).toEqual(new Date("2026-01-02T12:00:00.000Z"));
  });

  it("returns null when the tier never expires", () => {
    expect(computeExpiresAt(at, null)).toBeNull();
  });

  it("does not mutate its input", () => {
    computeExpiresAt(at, 5);
    expect(at.toISOString()).toBe("2026-01-01T12:00:00.000Z");
  });
});
