import { describe, expect, it } from "vitest";
import { ApiClientError, createApiClient } from "./api-client";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, client: createApiClient(fetchImpl) };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("api client: requests", () => {
  it("GET /api/metric with and without an operator", async () => {
    const { calls, client } = fakeFetch(() => json({ ok: 1 }));
    await client.getMetric();
    await client.getMetric("op 1");
    expect(calls.map((c) => c.url)).toEqual(["/api/metric", "/api/metric?operatorId=op%201"]);
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
  });

  it("GET /api/entries builds its query string from only the parameters given", async () => {
    const { calls, client } = fakeFetch(() => json({ entries: [], nextCursor: null }));
    await client.getEntries({ limit: 20 });
    await client.getEntries({ limit: 20, cursor: 57, operatorId: "op_1" });
    expect(calls.map((c) => c.url)).toEqual(["/api/entries?limit=20", "/api/entries?limit=20&cursor=57&operatorId=op_1"]);
  });

  it("GET the timeline for an operator, with an optional view", async () => {
    const { calls, client } = fakeFetch(() => json({ points: [] }));
    await client.getTimeline("op_1");
    await client.getTimeline("op_1", "full");
    expect(calls.map((c) => c.url)).toEqual(["/api/operators/op_1/timeline", "/api/operators/op_1/timeline?view=full"]);
  });

  it("POST /api/entries sends the units as JSON and the key in the Idempotency-Key header", async () => {
    const { calls, client } = fakeFetch(() => json({ replay: false, entry: { seq: 1 } }, 201));
    const result = await client.postEntry(25, "key-123");
    const call = calls[0]!;
    expect(call.url).toBe("/api/entries");
    expect(call.init.method).toBe("POST");
    expect(new Headers(call.init.headers).get("Idempotency-Key")).toBe("key-123");
    expect(new Headers(call.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(call.init.body as string)).toEqual({ units: 25 });
    expect(result).toEqual({ replay: false, entry: { seq: 1 } });
  });

  it("POST /api/adjustments sends targetSeq, units and reason, with the key header", async () => {
    const { calls, client } = fakeFetch(() => json({ replay: false, entry: { seq: 2 } }, 201));
    await client.postAdjustment({ targetSeq: 7, units: -5, reason: "Miscount" }, "adj-key");
    const call = calls[0]!;
    expect(call.url).toBe("/api/adjustments");
    expect(new Headers(call.init.headers).get("Idempotency-Key")).toBe("adj-key");
    expect(JSON.parse(call.init.body as string)).toEqual({ targetSeq: 7, units: -5, reason: "Miscount" });
  });

  it("POST /api/switch-user", async () => {
    const { calls, client } = fakeFetch(() => json({ user: { id: "u" } }));
    await client.switchUser("u");
    expect(calls[0]!.url).toBe("/api/switch-user");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ userId: "u" });
  });
});

describe("api client: errors", () => {
  const failure = async (response: Response | (() => never)) => {
    const { client } = fakeFetch(() => (typeof response === "function" ? response() : response));
    return client.postEntry(1, "k").then(
      () => null,
      (e: unknown) => e,
    );
  };

  it("maps the API's error body to an ApiClientError with its status, code and message", async () => {
    const err = await failure(json({ error: "CAPACITY_EXCEEDED", message: "The pool does not have enough capacity for this." }, 422));
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 422, code: "CAPACITY_EXCEEDED", retryable: false });
    expect((err as ApiClientError).message).toContain("capacity");
  });

  it("503 BUSY is retryable and carries Retry-After", async () => {
    const err = await failure(json({ error: "BUSY", message: "busy" }, 503, { "Retry-After": "1" }));
    expect(err).toMatchObject({ status: 503, code: "BUSY", retryable: true, retryAfterSeconds: 1 });
  });

  it("a network failure is retryable (the same key makes that safe)", async () => {
    const err = await failure(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(err).toMatchObject({ status: 0, code: "NETWORK", retryable: true });
  });

  it("a non-JSON error body still produces a usable error", async () => {
    const err = await failure(new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(err).toMatchObject({ status: 502, code: "HTTP_502" });
    expect((err as ApiClientError).retryable).toBe(true); // gateway errors are worth a retry
  });

  it.each([400, 401, 403, 404, 409, 422])("%i is not retryable", async (status) => {
    const err = await failure(json({ error: "X", message: "nope" }, status));
    expect(err).toMatchObject({ status, retryable: false });
  });

  it("an unauthenticated response is identifiable so the page can send the user to sign in", async () => {
    const err = await failure(json({ error: "UNAUTHENTICATED", message: "Not logged in." }, 401));
    expect(err).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });
});
