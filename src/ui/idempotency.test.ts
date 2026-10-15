import { describe, expect, it } from "vitest";
import { newIdempotencyKey } from "./idempotency";

describe("newIdempotencyKey", () => {
  it("is a string that fits the API's 1..200 character rule", () => {
    const key = newIdempotencyKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(200);
  });

  it("is different every time", () => {
    expect(new Set(Array.from({ length: 1000 }, () => newIdempotencyKey())).size).toBe(1000);
  });

  it("still works where crypto.randomUUID is unavailable (plain http on a LAN is not a secure context)", () => {
    const noUuid = { getRandomValues: (a: Uint8Array) => crypto.getRandomValues(a) } as unknown as Crypto;
    const a = newIdempotencyKey(noUuid);
    const b = newIdempotencyKey(noUuid);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});
