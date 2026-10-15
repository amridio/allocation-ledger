import { describe, expect, it, vi } from "vitest";
import { handleAllocate } from "./allocate-http";
import type { AllocateResult, LedgerEntryRecord } from "./ledger-types";

const entry: LedgerEntryRecord = {
  seq: 7,
  kind: "ALLOCATION",
  operatorId: "op_1",
  poolId: "pool_1",
  createdById: "op_1",
  units: 25,
  effectiveAt: new Date("2026-01-01T12:00:00.000Z"),
  recordedAt: new Date("2026-01-01T12:00:00.100Z"),
  expiresAt: new Date("2026-01-02T12:00:00.000Z"),
  refSeq: null,
  reason: null,
  idempotencyKey: "k-1",
};

const post = (body: unknown) =>
  new Request("http://localhost/api/allocations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const valid = { operatorId: "op_1", units: 25, idempotencyKey: "k-1" };
const run = (result: AllocateResult | Error, body: unknown = valid) => {
  const allocate = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { allocate, response: handleAllocate(post(body), allocate) };
};

describe("handleAllocate", () => {
  it("201 with the entry when newly created", async () => {
    const { response } = run({ ok: true, replay: false, entry });
    const res = await response;
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      replay: false,
      entry: { seq: 7, units: 25, effectiveAt: "2026-01-01T12:00:00.000Z", expiresAt: "2026-01-02T12:00:00.000Z" },
    });
  });

  it("200 and replay:true when the key was already used with the same payload", async () => {
    const res = await run({ ok: true, replay: true, entry }).response;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replay: true, entry: { seq: 7 } });
  });

  it("serializes a never-expiring entry as expiresAt null", async () => {
    const res = await run({ ok: true, replay: false, entry: { ...entry, expiresAt: null } }).response;
    expect((await res.json()).entry.expiresAt).toBeNull();
  });

  it("409 when the key was reused with a different payload", async () => {
    const res = await run({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" }).response;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("422 when the pool lacks capacity", async () => {
    const res = await run({ ok: false, reason: "CAPACITY_EXCEEDED" }).response;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "CAPACITY_EXCEEDED" });
  });

  it("404 when the operator does not exist", async () => {
    const res = await run({ ok: false, reason: "OPERATOR_NOT_FOUND" }).response;
    expect(res.status).toBe(404);
  });

  it("503 with Retry-After: 1 when busy (lock or transaction timeout); safe to retry with the same key", async () => {
    const res = await run({ ok: false, reason: "BUSY" }).response;
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toMatchObject({ error: "BUSY" });
  });

  it("400 for malformed JSON, without calling the service", async () => {
    const { allocate, response } = run({ ok: true, replay: false, entry }, "{not json");
    expect((await response).status).toBe(400);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("400 with field issues for an invalid body, without calling the service", async () => {
    const { allocate, response } = run({ ok: true, replay: false, entry }, { ...valid, units: 0 });
    const res = await response;
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("units");
    expect(allocate).not.toHaveBeenCalled();
  });

  it("passes only the validated input to the service", async () => {
    const { allocate, response } = run({ ok: true, replay: false, entry });
    await response;
    expect(allocate).toHaveBeenCalledWith(valid);
  });

  it("500 without leaking error details when the service throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await run(new Error("connection string postgres://secret@host")).response;
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
