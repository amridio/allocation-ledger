import { describe, expect, it } from "vitest";
import { changedPointKeys, type TimelinePointDto } from "./timeline-diff";

const p = (iso: string, balance: number, status: TimelinePointDto["status"]): TimelinePointDto => ({
  at: `2026-03-01T${iso}:00.000Z`,
  balance,
  status,
});

describe("changedPointKeys: which timeline points a refresh changed (so a supervisor can SEE an adjustment recalculate)", () => {
  const before = [p("09:00", 30, "LOW"), p("09:10", 55, "NORMAL"), p("09:20", 75, "NORMAL")];

  it("nothing changed -> no keys", () => {
    expect(changedPointKeys(before, [...before])).toEqual(new Set());
  });

  it("a backdated adjustment changes its own moment and every later one, never the earlier points", () => {
    const after = [p("09:00", 30, "LOW"), p("09:10", 45, "LOW"), p("09:20", 65, "NORMAL")];
    expect(changedPointKeys(before, after)).toEqual(new Set([after[1]!.at, after[2]!.at]));
  });

  it("a point whose balance is the same but whose status flipped counts as changed", () => {
    const after = [before[0]!, p("09:10", 55, "HIGH"), before[2]!];
    expect(changedPointKeys(before, after)).toEqual(new Set([after[1]!.at]));
  });

  it("a brand-new point is changed", () => {
    const after = [...before, p("09:30", 20, "LOW")];
    expect(changedPointKeys(before, after)).toEqual(new Set([after[3]!.at]));
  });

  it("a removed point is not reported (there is nothing to highlight)", () => {
    expect(changedPointKeys(before, [before[0]!])).toEqual(new Set());
  });

  it("with no previous timeline nothing is flagged: the first load isn't a 'change'", () => {
    expect(changedPointKeys(undefined, before)).toEqual(new Set());
    expect(changedPointKeys([], before)).toEqual(new Set());
  });
});
