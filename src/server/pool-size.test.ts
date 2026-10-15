import { describe, expect, it } from "vitest";
import { DEFAULT_POOL_SIZE, parsePoolSize } from "./pool-size";

describe("parsePoolSize (DATABASE_POOL_SIZE)", () => {
  it("defaults to 10 (the pg default) when unset or blank", () => {
    expect(DEFAULT_POOL_SIZE).toBe(10);
    for (const value of [undefined, "", "   "]) expect(parsePoolSize(value)).toBe(10);
  });

  it("accepts a positive whole number, ignoring surrounding spaces", () => {
    expect(parsePoolSize("1")).toBe(1);
    expect(parsePoolSize("25")).toBe(25);
    expect(parsePoolSize(" 40 ")).toBe(40);
  });

  it.each(["0", "-3", "1.5", "abc", "20abc", "1e2", "NaN", "Infinity", "0x10", "10 20"])(
    "rejects %j with an error that names the variable",
    (value) => {
      expect(() => parsePoolSize(value)).toThrowError(/DATABASE_POOL_SIZE/);
    },
  );
});
