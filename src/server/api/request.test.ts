import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readIdempotencyKey, readJsonBody, readQuery } from "./request";

const req = (init: { headers?: Record<string, string>; body?: string; url?: string } = {}) =>
  new Request(init.url ?? "http://localhost/api/x", {
    method: "POST",
    headers: init.headers,
    body: init.body,
  });

describe("readIdempotencyKey", () => {
  it("returns the Idempotency-Key header", () => {
    expect(readIdempotencyKey(req({ headers: { "Idempotency-Key": "abc-123" } }))).toBe("abc-123");
  });

  it("is case-insensitive about the header name", () => {
    expect(readIdempotencyKey(req({ headers: { "idempotency-key": "abc" } }))).toBe("abc");
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED when the header is missing or blank", () => {
    for (const headers of [{}, { "Idempotency-Key": "" }, { "Idempotency-Key": "   " }] as Record<string, string>[]) {
      expect(() => readIdempotencyKey(req({ headers }))).toThrowError(
        expect.objectContaining({ status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" }),
      );
    }
  });

  it("400 for a key longer than 200 characters", () => {
    expect(() => readIdempotencyKey(req({ headers: { "Idempotency-Key": "k".repeat(201) } }))).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe("readJsonBody", () => {
  it("parses a JSON body", async () => {
    expect(await readJsonBody(req({ body: '{"units":5}' }))).toEqual({ units: 5 });
  });

  it("400 INVALID_JSON for malformed or empty bodies", async () => {
    for (const body of ["{nope", "", undefined]) {
      await expect(readJsonBody(req({ body }))).rejects.toMatchObject({ status: 400, code: "INVALID_JSON" });
    }
  });
});

describe("readQuery", () => {
  const schema = z.object({ n: z.coerce.number().int().default(1) }).strict();

  it("parses and coerces the query string, applying defaults", () => {
    expect(readQuery(req({ url: "http://localhost/x?n=5" }), schema)).toEqual({ n: 5 });
    expect(readQuery(req({ url: "http://localhost/x" }), schema)).toEqual({ n: 1 });
  });

  it("throws a validation error (-> 400) for bad or unknown parameters", () => {
    expect(() => readQuery(req({ url: "http://localhost/x?n=abc" }), schema)).toThrow();
    expect(() => readQuery(req({ url: "http://localhost/x?other=1" }), schema)).toThrow();
  });
});
