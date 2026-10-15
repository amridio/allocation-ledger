import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adjust } from "../adjust";
import { allocate } from "../allocate";
import {
  T0,
  db,
  deps,
  fixture,
  ledger,
  minutes,
  otherConnection,
  supervisorIn,
} from "../testing/int-helpers";
import { createAdjustment } from "./adjustments";
import type { ApiContext } from "./context";
import { createEntry, listEntries } from "./entries";
import { getMetric } from "./metric";
import { switchUser } from "./session";
import { getTimeline } from "./timeline";

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  await db.$disconnect();
});
afterEach(() => vi.restoreAllMocks());

const ctx = (now: Date = T0, extra: Partial<ApiContext> = {}): ApiContext => ({ db, clock: () => now, ...extra });

function request(
  path: string,
  o: { method?: string; as?: string; key?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (o.as) headers["cookie"] = `uid=${o.as}`;
  if (o.key) headers["Idempotency-Key"] = o.key;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: o.method ?? (o.body === undefined && !o.key ? "GET" : "POST"),
    headers,
    body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
  });
}

/** One pool with two operators and a supervisor, plus an unrelated pool with its own operator. */
async function world(opts: { capacity?: number | null; expiryMinutes?: number | null } = {}) {
  const f = await fixture(opts);
  const op2 = await db.operator.create({ data: { name: "op2", tierId: f.tierId, poolId: f.poolId } });
  const sup = await supervisorIn(f);
  const other = await fixture();
  return { ...f, op1: f.operatorId, op2: op2.id, sup, otherOp: other.operatorId, otherPool: other.poolId };
}
const give = async (operatorId: string, units: number, key: string, now: Date = T0) => {
  const r = await allocate(deps(now), { operatorId, units, idempotencyKey: key });
  if (!r.ok) throw new Error(`setup allocation failed: ${r.reason}`);
  return r.entry;
};

describe("authentication (temporary cookie)", () => {
  it("every endpoint answers 401 without a cookie, and with a cookie for a user that doesn't exist", async () => {
    const w = await world();
    for (const as of [undefined, "ghost"]) {
      const calls = [
        createEntry(request("/api/entries", { as, key: "k", body: { units: 1 } }), ctx()),
        createAdjustment(request("/api/adjustments", { as, key: "k", body: { targetSeq: 1, units: 1, reason: "r" } }), ctx()),
        listEntries(request("/api/entries", { as }), ctx()),
        getMetric(request("/api/metric", { as }), ctx()),
        getTimeline(request("/api/operators/x/timeline", { as }), ctx(), w.op1),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(401);
        expect(await res.json()).toMatchObject({ error: "UNAUTHENTICATED" });
      }
    }
  });

  it("switch-user sets the cookie, and that cookie then logs you in", async () => {
    const w = await world();
    const res = await switchUser(request("/api/switch-user", { body: { userId: w.op1 } }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { id: w.op1, role: "OPERATOR", poolId: w.poolId } });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`uid=${w.op1}`);
    expect(setCookie).toContain("HttpOnly");

    const cookieValue = setCookie.split(";")[0] ?? "";
    const metric = await getMetric(
      new Request("http://localhost/api/metric", { headers: { cookie: cookieValue } }),
      ctx(),
    );
    expect(metric.status).toBe(200);
  });

  it("switch-user: 404 for an unknown user, 400 for a bad body, and no cookie is set", async () => {
    const unknown = await switchUser(request("/api/switch-user", { body: { userId: "ghost" } }), ctx());
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("set-cookie")).toBeNull();
    for (const body of [{}, { userId: "" }, { userId: "a", extra: 1 }, "{nope"]) {
      const res = await switchUser(request("/api/switch-user", { body }), ctx());
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /api/entries", () => {
  it("201 creates; the operator comes from the cookie and effectiveAt from the server clock", async () => {
    const w = await world({ expiryMinutes: 60 });
    const res = await createEntry(request("/api/entries", { as: w.op1, key: "e-1", body: { units: 25 } }), ctx(T0));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      replay: false,
      entry: { kind: "ALLOCATION", operatorId: w.op1, createdById: w.op1, units: 25, effectiveAt: T0.toISOString(), expiresAt: minutes(T0, 60).toISOString() },
    });
    expect(await ledger(w.poolId)).toMatchObject({ count: 1, balance: 25 });
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED without the header; nothing is written", async () => {
    const w = await world();
    const res = await createEntry(request("/api/entries", { as: w.op1, method: "POST", body: { units: 5 } }), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "IDEMPOTENCY_KEY_REQUIRED" });
    expect((await ledger(w.poolId)).count).toBe(0);
  });

  it("200 replay for the same key and body; 409 for the same key with different units", async () => {
    const w = await world();
    const first = await createEntry(request("/api/entries", { as: w.op1, key: "e-2", body: { units: 25 } }), ctx());
    const replay = await createEntry(request("/api/entries", { as: w.op1, key: "e-2", body: { units: 25 } }), ctx(minutes(T0, 5)));
    const reuse = await createEntry(request("/api/entries", { as: w.op1, key: "e-2", body: { units: 26 } }), ctx());

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect((await replay.json()).entry.seq).toBe((await first.json()).entry.seq);
    expect(reuse.status).toBe(409);
    expect(await reuse.json()).toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await ledger(w.poolId)).toMatchObject({ count: 1, balance: 25 });
  });

  it("422 CAPACITY_EXCEEDED when the pool is full", async () => {
    const w = await world({ capacity: 30 });
    await give(w.op1, 20, "fill");
    const res = await createEntry(request("/api/entries", { as: w.op1, key: "e-3", body: { units: 20 } }), ctx());
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "CAPACITY_EXCEEDED" });
  });

  it("403 for a supervisor (only operators log allocations)", async () => {
    const w = await world();
    const res = await createEntry(request("/api/entries", { as: w.sup, key: "e-4", body: { units: 5 } }), ctx());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "FORBIDDEN" });
    expect((await ledger(w.poolId)).count).toBe(0);
  });

  it("400 for an invalid body, including fields the server owns; an operator can't log for someone else", async () => {
    const w = await world();
    const bodies: unknown[] = [
      { units: 0 },
      { units: 1.5 },
      {},
      "{nope",
      { units: 5, operatorId: w.op2 },
      { units: 5, idempotencyKey: "in-body" },
      { units: 5, effectiveAt: "2020-01-01T00:00:00Z" },
    ];
    for (const body of bodies) {
      const res = await createEntry(request("/api/entries", { as: w.op1, key: "e-5", body }), ctx());
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await ledger(w.poolId)).count).toBe(0);
  });

  it("503 with Retry-After: 1 when the pool lock can't be had; retrying with the same key then works", async () => {
    const w = await world();
    const holder = await otherConnection();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM pool WHERE id = $1 FOR UPDATE", [w.poolId]);
      const busy = await createEntry(
        request("/api/entries", { as: w.op1, key: "e-6", body: { units: 5 } }),
        ctx(T0, { lockTimeoutMs: 200 }),
      );
      expect(busy.status).toBe(503);
      expect(busy.headers.get("Retry-After")).toBe("1");
      expect(await busy.json()).toMatchObject({ error: "BUSY" });

      await holder.query("ROLLBACK");
      const retry = await createEntry(request("/api/entries", { as: w.op1, key: "e-6", body: { units: 5 } }), ctx());
      expect(retry.status).toBe(201);
      expect(await ledger(w.poolId)).toMatchObject({ count: 1, balance: 5 });
    } finally {
      await holder.end();
    }
  });

  it("10 simultaneous identical requests: one 201, nine 200s, one row", async () => {
    const w = await world();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => createEntry(request("/api/entries", { as: w.op1, key: "e-race", body: { units: 7 } }), ctx())),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(9);
    expect(await ledger(w.poolId)).toMatchObject({ count: 1, sum: 7, balance: 7 });
  });
});

describe("POST /api/adjustments", () => {
  it("201 for a supervisor: points at the target and copies its effectiveAt / expiresAt", async () => {
    const w = await world({ expiryMinutes: 60 });
    const target = await give(w.op1, 30, "t-1");
    const res = await createAdjustment(
      request("/api/adjustments", { as: w.sup, key: "a-1", body: { targetSeq: target.seq, units: -10, reason: "Miscount" } }),
      ctx(minutes(T0, 30)),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      replay: false,
      entry: {
        kind: "ADJUSTMENT",
        operatorId: w.op1,
        createdById: w.sup,
        units: -10,
        refSeq: target.seq,
        reason: "Miscount",
        effectiveAt: T0.toISOString(),
        expiresAt: minutes(T0, 60).toISOString(),
      },
    });
    expect(await ledger(w.poolId)).toMatchObject({ count: 2, balance: 20 });
  });

  it("403 for an operator; nothing written", async () => {
    const w = await world();
    const target = await give(w.op1, 30, "t-2");
    const res = await createAdjustment(
      request("/api/adjustments", { as: w.op1, key: "a-2", body: { targetSeq: target.seq, units: -10, reason: "r" } }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect((await ledger(w.poolId)).count).toBe(1);
  });

  it("400 without the key, or without a reason, or with server-owned fields", async () => {
    const w = await world();
    const target = await give(w.op1, 30, "t-3");
    const good = { targetSeq: target.seq, units: -1, reason: "r" };
    const noKey = await createAdjustment(request("/api/adjustments", { as: w.sup, method: "POST", body: good }), ctx());
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: "IDEMPOTENCY_KEY_REQUIRED" });
    for (const body of [{ ...good, reason: "" }, { targetSeq: target.seq, units: -1 }, { ...good, effectiveAt: "2020-01-01" }, { ...good, units: 0 }]) {
      const res = await createAdjustment(request("/api/adjustments", { as: w.sup, key: "a-3", body }), ctx());
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await ledger(w.poolId)).count).toBe(1);
  });

  it("404 for an unknown target, 422 when the target is itself an adjustment", async () => {
    const w = await world();
    const target = await give(w.op1, 30, "t-4");
    const missing = await createAdjustment(
      request("/api/adjustments", { as: w.sup, key: "a-4", body: { targetSeq: 2_000_000_000, units: -1, reason: "r" } }),
      ctx(),
    );
    expect(missing.status).toBe(404);

    const made = await adjust(deps(), { supervisorId: w.sup, targetSeq: target.seq, units: -1, reason: "r", idempotencyKey: "a-5" });
    if (!made.ok) throw new Error("setup failed");
    const onAdjustment = await createAdjustment(
      request("/api/adjustments", { as: w.sup, key: "a-6", body: { targetSeq: made.entry.seq, units: -1, reason: "r" } }),
      ctx(),
    );
    expect(onAdjustment.status).toBe(422);
    expect(await onAdjustment.json()).toMatchObject({ error: "TARGET_NOT_ALLOCATION" });
  });

  it("200 replay, 409 on a different payload, 422 when a positive adjustment would exceed capacity", async () => {
    const w = await world({ capacity: 40 });
    const target = await give(w.op1, 40, "t-5");
    const body = { targetSeq: target.seq, units: -5, reason: "r" };
    const first = await createAdjustment(request("/api/adjustments", { as: w.sup, key: "a-7", body }), ctx());
    const replay = await createAdjustment(request("/api/adjustments", { as: w.sup, key: "a-7", body }), ctx());
    const reuse = await createAdjustment(request("/api/adjustments", { as: w.sup, key: "a-7", body: { ...body, units: -6 } }), ctx());
    const tooMuch = await createAdjustment(
      request("/api/adjustments", { as: w.sup, key: "a-8", body: { targetSeq: target.seq, units: 6, reason: "r" } }),
      ctx(),
    );
    expect([first.status, replay.status, reuse.status, tooMuch.status]).toEqual([201, 200, 409, 422]);
  });
});

describe("POST /api/adjustments: pool boundary and over-correction", () => {
  it("403 TARGET_OTHER_POOL when a supervisor adjusts an entry in another pool; nothing changes", async () => {
    const mine = await world();
    const theirs = await world();
    const target = await give(theirs.op1, 30, "xp-1");
    const res = await createAdjustment(
      request("/api/adjustments", { as: mine.sup, key: "xp-a", body: { targetSeq: target.seq, units: -5, reason: "r" } }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "TARGET_OTHER_POOL" });
    expect(await ledger(theirs.poolId)).toMatchObject({ count: 1, balance: 30 });
  });

  it("422 ADJUSTMENT_BELOW_ZERO when the entry's net units would go negative", async () => {
    const w = await world();
    const target = await give(w.op1, 30, "bz-1");
    const res = await createAdjustment(
      request("/api/adjustments", { as: w.sup, key: "bz-a", body: { targetSeq: target.seq, units: -31, reason: "r" } }),
      ctx(),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "ADJUSTMENT_BELOW_ZERO" });
    const ok = await createAdjustment(
      request("/api/adjustments", { as: w.sup, key: "bz-b", body: { targetSeq: target.seq, units: -30, reason: "r" } }),
      ctx(),
    );
    expect(ok.status).toBe(201);
  });
});

describe("GET /api/entries (cursor pagination by seq)", () => {
  /** op1 gets 7 allocations; returns their seqs oldest -> newest. */
  async function sevenEntries(w: Awaited<ReturnType<typeof world>>) {
    const seqs: number[] = [];
    for (let i = 0; i < 7; i++) seqs.push((await give(w.op1, 1 + i, `p-${i}`, minutes(T0, i))).seq);
    return seqs;
  }
  const page = async (as: string, query: string) => listEntries(request(`/api/entries${query}`, { as }), ctx());

  it("pages newest first; every entry appears exactly once; the last page has nextCursor null", async () => {
    const w = await world();
    const seqs = await sevenEntries(w);
    const newestFirst = [...seqs].reverse();

    const seen: number[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const res = await page(w.op1, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries.length).toBeLessThanOrEqual(3);
      seen.push(...body.entries.map((e: { seq: number }) => e.seq));
      cursor = body.nextCursor;
      pages++;
    } while (cursor !== null && pages < 10);

    expect(seen).toEqual(newestFirst);
    expect(pages).toBe(3); // 3 + 3 + 1
  });

  it("no phantom empty page when the last page is exactly full", async () => {
    const w = await world();
    for (let i = 0; i < 6; i++) await give(w.op1, 1, `q-${i}`, minutes(T0, i));
    const first = await (await page(w.op1, "?limit=3")).json();
    const second = await (await page(w.op1, `?limit=3&cursor=${first.nextCursor}`)).json();
    expect(first.entries).toHaveLength(3);
    expect(second.entries).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
  });

  it("a new entry arriving between pages neither duplicates nor skips anything", async () => {
    const w = await world();
    const seqs = await sevenEntries(w);
    const first = await (await page(w.op1, "?limit=3")).json();
    await give(w.op1, 99, "arrives-late", minutes(T0, 50));
    const second = await (await page(w.op1, `?limit=3&cursor=${first.nextCursor}`)).json();

    const all = [...first.entries, ...second.entries].map((e: { seq: number }) => e.seq);
    expect(all).toEqual([...seqs].reverse().slice(0, 6));
  });

  it("includes adjustments, in seq order with the allocations", async () => {
    const w = await world();
    const target = await give(w.op1, 30, "r-1");
    const adj = await adjust(deps(), { supervisorId: w.sup, targetSeq: target.seq, units: -5, reason: "r", idempotencyKey: "r-2" });
    if (!adj.ok) throw new Error("setup failed");
    const body = await (await page(w.op1, "")).json();
    expect(body.entries.map((e: { kind: string }) => e.kind)).toEqual(["ADJUSTMENT", "ALLOCATION"]);
  });

  it("an operator sees only their own entries and may not ask for someone else's", async () => {
    const w = await world();
    await give(w.op1, 5, "o-1");
    await give(w.op2, 6, "o-2");
    const own = await (await page(w.op1, "")).json();
    expect(own.entries.map((e: { operatorId: string }) => e.operatorId)).toEqual([w.op1]);

    expect((await page(w.op1, `?operatorId=${w.op1}`)).status).toBe(200);
    const other = await page(w.op1, `?operatorId=${w.op2}`);
    expect(other.status).toBe(403);
  });

  it("a supervisor sees their whole pool (never another pool), and can filter to one operator", async () => {
    const w = await world();
    await give(w.op1, 5, "s-1");
    await give(w.op2, 6, "s-2");
    await give(w.otherOp, 7, "s-3");

    const all = await (await page(w.sup, "")).json();
    expect(all.entries.map((e: { operatorId: string }) => e.operatorId).sort()).toEqual([w.op1, w.op2].sort());

    const one = await (await page(w.sup, `?operatorId=${w.op2}`)).json();
    expect(one.entries.map((e: { operatorId: string }) => e.operatorId)).toEqual([w.op2]);

    expect((await page(w.sup, "?operatorId=ghost")).status).toBe(404);
  });

  it("400 for bad paging parameters", async () => {
    const w = await world();
    for (const q of ["?limit=0", "?limit=101", "?cursor=abc", "?cursor=0", "?cursor=-1", "?bogus=1"]) {
      expect((await page(w.op1, q)).status, q).toBe(400);
    }
  });
});

describe("GET /api/metric", () => {
  it("an operator's active units and status, plus the pool's capacity, active units and lifetime balance", async () => {
    const w = await world({ capacity: 500, expiryMinutes: 60 });
    await give(w.op1, 30, "m-1", T0); // expires T0+60
    await give(w.op1, 10, "m-2", minutes(T0, 90)); // expires T0+150

    const at30 = await (await getMetric(request("/api/metric", { as: w.op1 }), ctx(minutes(T0, 30)))).json();
    expect(at30).toMatchObject({
      asOf: minutes(T0, 30).toISOString(),
      operator: { id: w.op1, activeUnits: 30, status: "LOW" },
      pool: { id: w.poolId, capacity: 500, activeUnits: 30, lifetimeBalance: 40 },
    });

    const at100 = await (await getMetric(request("/api/metric", { as: w.op1 }), ctx(minutes(T0, 100)))).json();
    expect(at100).toMatchObject({
      operator: { activeUnits: 10, status: "CRITICAL" }, // the first 30 expired; 10 is below the LOW cutoff
      pool: { activeUnits: 10, lifetimeBalance: 40 }, // the cached balance still includes expired units
    });
  });

  it("a brand-new operator is 0 units and CRITICAL", async () => {
    const w = await world();
    const body = await (await getMetric(request("/api/metric", { as: w.op2 }), ctx())).json();
    expect(body.operator).toMatchObject({ activeUnits: 0, status: "CRITICAL" });
  });

  it("a supervisor can look at any operator; an operator can't look at someone else; unknown is 404", async () => {
    const w = await world();
    await give(w.op1, 120, "m-3");
    const asSup = await (await getMetric(request(`/api/metric?operatorId=${w.op1}`, { as: w.sup }), ctx())).json();
    expect(asSup.operator).toMatchObject({ id: w.op1, activeUnits: 120, status: "HIGH" });

    expect((await getMetric(request(`/api/metric?operatorId=${w.op1}`, { as: w.op2 }), ctx())).status).toBe(403);
    expect((await getMetric(request("/api/metric?operatorId=ghost", { as: w.sup }), ctx())).status).toBe(404);
    expect((await getMetric(request("/api/metric?x=1", { as: w.op1 }), ctx())).status).toBe(400);
  });
});

describe("GET /api/operators/:id/timeline", () => {
  /**
   * op1 (tier: 60 min):  A +30 @0, B +25 @10, C +20 @20, supervisor adjusts B by -10 (dated @10),
   * so: @0 30, @10 45, @20 65, @60 35 (A expires), @70 20 (B and its adjustment expire), @80 0 (C expires).
   */
  async function story() {
    const w = await world({ expiryMinutes: 60 });
    await give(w.op1, 30, "tl-a", T0);
    const b = await give(w.op1, 25, "tl-b", minutes(T0, 10));
    await give(w.op1, 20, "tl-c", minutes(T0, 20));
    const adj = await adjust(deps(minutes(T0, 30)), { supervisorId: w.sup, targetSeq: b.seq, units: -10, reason: "r", idempotencyKey: "tl-j" });
    if (!adj.ok) throw new Error("setup failed");
    return w;
  }
  const point = (min: number, balance: number, status: string) => ({ at: minutes(T0, min).toISOString(), balance, status });
  const get = (w: { op1: string }, as: string, query = "") =>
    getTimeline(request(`/api/operators/${w.op1}/timeline${query}`, { as }), ctx(minutes(T0, 90)), w.op1);

  it("an operator sees their own status transitions only (the default)", async () => {
    const w = await story();
    const res = await get(w, w.op1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      operatorId: w.op1,
      view: "transitions",
      asOf: minutes(T0, 90).toISOString(),
      points: [point(0, 30, "LOW"), point(20, 65, "NORMAL"), point(60, 35, "LOW"), point(80, 0, "CRITICAL")],
    });
  });

  it("a supervisor sees every balance change by default, including the backdated adjustment's effect", async () => {
    const w = await story();
    const body = await (await get(w, w.sup)).json();
    expect(body.view).toBe("full");
    expect(body.points).toEqual([
      point(0, 30, "LOW"),
      point(10, 45, "LOW"), // 30 + 25 - 10: the adjustment is dated at B's time even though it was made at @30
      point(20, 65, "NORMAL"),
      point(60, 35, "LOW"),
      point(70, 20, "LOW"),
      point(80, 0, "CRITICAL"),
    ]);
  });

  it("every transition is also a point of the full timeline", async () => {
    const w = await story();
    const full = (await (await get(w, w.sup, "?view=full")).json()).points;
    const transitions = (await (await get(w, w.sup, "?view=transitions")).json()).points;
    expect(transitions.length).toBeLessThan(full.length);
    for (const p of transitions) expect(full).toContainEqual(p);
  });

  it("an operator can't ask for the full view (403), but may ask for transitions explicitly", async () => {
    const w = await story();
    expect((await get(w, w.op1, "?view=full")).status).toBe(403);
    expect((await get(w, w.op1, "?view=transitions")).status).toBe(200);
  });

  it("an operator can't read another operator's timeline: 403, even for an id that doesn't exist", async () => {
    const w = await story();
    expect((await get(w, w.op2)).status).toBe(403);
    const ghost = await getTimeline(request("/api/operators/ghost/timeline", { as: w.op1 }), ctx(), "ghost");
    expect(ghost.status).toBe(403);
  });

  it("a supervisor gets 404 for an unknown operator and 400 for a bad view", async () => {
    const w = await story();
    expect((await getTimeline(request("/api/operators/ghost/timeline", { as: w.sup }), ctx(), "ghost")).status).toBe(404);
    expect((await get(w, w.sup, "?view=all")).status).toBe(400);
  });

  it("an operator with no entries has an empty timeline", async () => {
    const w = await world();
    const res = await getTimeline(request(`/api/operators/${w.op2}/timeline`, { as: w.op2 }), ctx(), w.op2);
    expect((await res.json()).points).toEqual([]);
  });
});

describe("the shared error handler, end to end", () => {
  it("an unexpected failure is a 500 with no message, stack or connection details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = await world();
    const brokenDb = {
      operator: {
        findUnique: async () => {
          throw new Error("password authentication failed for user admin at postgres://admin:s3cret@db:5432/prod");
        },
      },
    } as unknown as ApiContext["db"];

    const responses = await Promise.all([
      createEntry(request("/api/entries", { as: w.op1, key: "x", body: { units: 1 } }), { db: brokenDb, clock: () => T0 }),
      listEntries(request("/api/entries", { as: w.op1 }), { db: brokenDb, clock: () => T0 }),
      getMetric(request("/api/metric", { as: w.op1 }), { db: brokenDb, clock: () => T0 }),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "INTERNAL", message: "Something went wrong." });
      for (const leak of ["s3cret", "postgres://", "password", "admin", " at ", ".ts:"]) expect(text).not.toContain(leak);
    }
  });

  it("every response is JSON and uncacheable, success or failure", async () => {
    const w = await world();
    const ok = await getMetric(request("/api/metric", { as: w.op1 }), ctx());
    const fail = await getMetric(request("/api/metric"), ctx());
    for (const res of [ok, fail]) {
      expect(res.headers.get("Content-Type")).toContain("application/json");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });
});
