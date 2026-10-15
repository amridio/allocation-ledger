import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";

describe("contrastRatio (WCAG 2.x)", () => {
  it("black on white is 21:1 and the ratio is symmetric", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  it("identical colours are 1:1", () => {
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("matches known reference values", () => {
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1); // the classic 'just fails AA'
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 1); // the lightest grey that passes AA
  });

  it("accepts #rgb shorthand and any case", () => {
    expect(contrastRatio("#FFF", "#000")).toBeCloseTo(21, 5);
  });

  it("rejects things that aren't hex colours", () => {
    expect(() => contrastRatio("red", "#fff")).toThrow();
    expect(() => contrastRatio("#12345", "#fff")).toThrow();
  });
});
