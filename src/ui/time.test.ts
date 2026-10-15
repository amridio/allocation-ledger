import { describe, expect, it } from "vitest";
import { formatClock, formatWhen, resolveTimeZone } from "./time";

describe("time display (a FIXED time zone, so the server and the browser print the same text)", () => {
  it("formatClock prints 24-hour HH:MM in the given zone", () => {
    expect(formatClock("2026-03-01T14:03:00.000Z", "UTC")).toBe("14:03");
    expect(formatClock("2026-03-01T14:03:00.000Z", "Europe/Berlin")).toBe("15:03"); // UTC+1 in early March
    expect(formatClock("2026-07-01T14:03:00.000Z", "Europe/Berlin")).toBe("16:03"); // UTC+2 in summer
    expect(formatClock("2026-03-01T00:05:00.000Z", "UTC")).toBe("00:05");
  });

  it("formatWhen drops the date for today and adds it for other days", () => {
    const now = new Date("2026-03-01T20:00:00.000Z");
    expect(formatWhen("2026-03-01T14:03:00.000Z", now, "UTC")).toBe("14:03");
    expect(formatWhen("2026-02-28T14:03:00.000Z", now, "UTC")).toBe("28 Feb 14:03");
    expect(formatWhen("2026-03-02T01:00:00.000Z", now, "UTC")).toBe("2 Mar 01:00"); // upcoming points on a later day
  });

  it("'today' is decided in the display zone, not in UTC", () => {
    const now = new Date("2026-03-01T23:30:00.000Z"); // already 00:30 on the 2nd in Berlin
    expect(formatWhen("2026-03-01T22:30:00.000Z", now, "Europe/Berlin")).toBe("1 Mar 23:30"); // yesterday in Berlin...
    expect(formatWhen("2026-03-01T22:30:00.000Z", now, "UTC")).toBe("22:30"); // ...but today in UTC
  });

  it("resolveTimeZone accepts a real IANA zone and falls back to UTC for anything else", () => {
    expect(resolveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveTimeZone("UTC")).toBe("UTC");
    expect(resolveTimeZone(undefined)).toBe("UTC");
    expect(resolveTimeZone("")).toBe("UTC");
    expect(resolveTimeZone("Not/AZone")).toBe("UTC");
  });
});
