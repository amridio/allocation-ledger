import { describe, expect, it } from "vitest";
import { describeExpiry, formatSigned, metricFontPx } from "./format";

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

describe("metricFontPx: the big number is 72px unless its digits would not fit a 360px phone", () => {
  it("is the 72px design size for up to 5 digits", () => {
    for (const n of [0, 7, 125, 99_999]) expect(metricFontPx(n)).toBe(72);
  });

  it("steps down so every digit stays in the card, and never below 48px", () => {
    expect(metricFontPx(100_000)).toBe(60); // 6 digits
    expect(metricFontPx(1_234_567)).toBe(52); // 7 digits
    expect(metricFontPx(12_345_678)).toBe(48);
    expect(metricFontPx(9_999_999_999)).toBe(48);
  });

  it("never grows as the number grows", () => {
    let last = Infinity;
    for (const n of [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9]) {
      expect(metricFontPx(n)).toBeLessThanOrEqual(last);
      last = metricFontPx(n);
    }
  });
});
