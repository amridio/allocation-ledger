import { describe, expect, it } from "vitest";
import { describeExpiry, formatSigned } from "./format";

const now = new Date("2026-03-01T12:00:00.000Z");
const inMs = (ms: number) => new Date(now.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("describeExpiry (same boundary rule as the domain: at the exact expiry it is already expired)", () => {
  it("null means it never expires", () => {
    expect(describeExpiry(null, now)).toEqual({ kind: "none", text: "No expiry" });
  });

  it("expired, including exactly at the expiry instant", () => {
    expect(describeExpiry(inMs(-HOUR), now)).toEqual({ kind: "expired", text: "Expired" });
    expect(describeExpiry(inMs(0), now)).toEqual({ kind: "expired", text: "Expired" });
  });

  it("counts down in the largest sensible units", () => {
    expect(describeExpiry(inMs(1), now)).toEqual({ kind: "active", text: "Expires in under 1 min" });
    expect(describeExpiry(inMs(59_999), now).text).toBe("Expires in under 1 min");
    expect(describeExpiry(inMs(MIN), now).text).toBe("Expires in 1 min");
    expect(describeExpiry(inMs(45 * MIN + 30_000), now).text).toBe("Expires in 45 min");
    expect(describeExpiry(inMs(HOUR), now).text).toBe("Expires in 1 h");
    expect(describeExpiry(inMs(2 * HOUR + 5 * MIN), now).text).toBe("Expires in 2 h 5 min");
    expect(describeExpiry(inMs(24 * HOUR), now).text).toBe("Expires in 1 d");
    expect(describeExpiry(inMs(3 * 24 * HOUR + 4 * HOUR + 59 * MIN), now).text).toBe("Expires in 3 d 4 h");
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(describeExpiry(new Date(now.getTime() + 2 * HOUR), now).text).toBe("Expires in 2 h");
  });
});

describe("formatSigned", () => {
  it("always shows the sign, using a real minus sign", () => {
    expect(formatSigned(25)).toBe("+25");
    expect(formatSigned(-5)).toBe("−5");
    expect(formatSigned(0)).toBe("0");
  });
});
