import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeBalance, type DomainEntry } from "@/domain/ledger";
import { allocate } from "./allocate";
import { getActiveUnits } from "./ledger-tx";
import {
  T0,
  db,
  deps,
  fixture,
  ledger,
  minutes,
  otherConnection,
  sleep,
  waitUntilSomeBackendWaitsOnALock,
} from "./testing/int-helpers";

const input = (operatorId: string, units: number, idempotencyKey: string) => ({ operatorId, units, idempotencyKey });

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  await db.$disconnect();
});

describe("allocate: basics", () => {
  it("creates an entry: server-set effectiveAt, expiry from the operator's tier, balance updated", async () => {
    const f = await fixture({ expiryMinutes: 60 });
    const result = await allocate(deps(T0), input(f.operatorId, 25, "k-basic"));

    expect(result).toMatchObject({ ok: true, replay: false });
    if (!result.ok) throw new Error("unreachable");
    expect(result.entry).toMatchObject({
      kind: "ALLOCATION",
      operatorId: f.operatorId,
      createdById: f.operatorId,
      poolId: f.poolId,
      units: 25,
      refSeq: null,
    });
    expect(result.entry.effectiveAt).toEqual(T0);
    expect(result.entry.expiresAt).toEqual(minutes(T0, 60));

    const l = await ledger(f.poolId);
    expect(l).toMatchObject({ count: 1, sum: 25, balance: 25 });
  });

  it("a tier that never expires gives expiresAt null", async () => {
    const f = await fixture({ expiryMinutes: null });
    const result = await allocate(deps(T0), input(f.operatorId, 10, "k-never"));
    expect(result.ok && result.entry.expiresAt).toBeNull();
  });

  it("OPERATOR_NOT_FOUND for an unknown operator, and writes nothing", async () => {
    expect(await allocate(deps(), input("no-such-operator", 5, "k-x"))).toEqual({
      ok: false,
      reason: "OPERATOR_NOT_FOUND",
    });
  });
});

describe("allocate: idempotency", () => {
  it("replays the original row for the same key and payload; balance and ledger don't change", async () => {
    const f = await fixture();
    const first = await allocate(deps(T0), input(f.operatorId, 25, "k-replay"));
    const second = await allocate(deps(T0), input(f.operatorId, 25, "k-replay"));

    expect(first).toMatchObject({ ok: true, replay: false });
    expect(second).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.entry.seq).toBe(first.entry.seq);
    expect(await ledger(f.poolId)).toMatchObject({ count: 1, sum: 25, balance: 25 });
  });

  it("a genuine retry is accepted even though the server clock (effectiveAt) has moved on", async () => {
    const f = await fixture();
    const first = await allocate(deps(T0), input(f.operatorId, 25, "k-late"));
    const retry = await allocate(deps(minutes(T0, 5)), input(f.operatorId, 25, "k-late"));

    expect(retry).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !retry.ok) throw new Error("unreachable");
    expect(retry.entry.effectiveAt).toEqual(T0); // the ORIGINAL row, not a new timestamp
    expect(await ledger(f.poolId)).toMatchObject({ count: 1, balance: 25 });
  });

  it("IDEMPOTENCY_KEY_REUSED when the same key comes with different units; nothing is written", async () => {
    const f = await fixture();
    await allocate(deps(T0), input(f.operatorId, 25, "k-reuse"));
    const result = await allocate(deps(T0), input(f.operatorId, 50, "k-reuse"));

    expect(result).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
    expect(await ledger(f.poolId)).toMatchObject({ count: 1, sum: 25, balance: 25 });
  });

  it("the same key from a different operator is a different request", async () => {
    const a = await fixture();
    const b = await fixture();
    const ra = await allocate(deps(T0), input(a.operatorId, 5, "shared-key"));
    const rb = await allocate(deps(T0), input(b.operatorId, 5, "shared-key"));
    expect(ra).toMatchObject({ ok: true, replay: false });
    expect(rb).toMatchObject({ ok: true, replay: false });
  });

  it("10 simultaneous requests with the SAME key produce exactly one row and one balance change", async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => allocate(deps(T0), input(f.operatorId, 7, "k-race"))),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const created = results.filter((r) => r.ok && !r.replay);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.ok && r.replay)).toHaveLength(9);
    const seqs = new Set(results.map((r) => (r.ok ? r.entry.seq : null)));
    expect(seqs.size).toBe(1);
    expect(await ledger(f.poolId)).toMatchObject({ count: 1, sum: 7, balance: 7 });
  });

  it("10 simultaneous requests with DIFFERENT keys: every one lands and balance equals the ledger sum", async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => allocate(deps(T0), input(f.operatorId, 5 + i, `k-par-${i}`))),
    );

    expect(results.every((r) => r.ok && !r.replay)).toBe(true);
    const l = await ledger(f.poolId);
    expect(l.count).toBe(10);
    expect(l.sum).toBe(5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14);
    expect(l.balance).toBe(l.sum);
    // seq is in commit order within a pool: no seq is lower than one that committed before it
    expect(new Set(l.rows.map((r) => r.seq)).size).toBe(10);
  });

  // An uncommitted INSERT into ledger_entry holds FOR KEY SHARE on its pool row (foreign key),
  // which conflicts with our FOR UPDATE. So even a writer that never takes the pool lock still
  // queues us behind it, and our lookup then sees its committed row.
  it("an uncommitted insert of the same key by a writer that skips the pool lock still serializes: answered as a replay", async () => {
    const f = await fixture();
    const other = await otherConnection();
    try {
      // Another writer inserts the same key but has NOT committed, and does not take the pool lock.
      await other.query("BEGIN");
      await other.query(
        `INSERT INTO ledger_entry (kind, operator_id, pool_id, created_by_id, units, effective_at, expires_at, idempotency_key)
         VALUES ('ALLOCATION', $1, $2, $1, 10, $3, $4, 'k-unique-race')`,
        [f.operatorId, f.poolId, T0, minutes(T0, 60)],
      );

      const pending = allocate(deps(T0, { lockTimeoutMs: 8000 }), input(f.operatorId, 10, "k-unique-race"));
      // The service blocks on the pool row (held FOR KEY SHARE by the uncommitted insert's foreign key).
      await waitUntilSomeBackendWaitsOnALock();
      await other.query("COMMIT");

      const result = await pending;
      expect(result).toMatchObject({ ok: true, replay: true });
      const l = await ledger(f.poolId);
      expect(l.count).toBe(1); // exactly the other writer's row; the service added nothing and didn't touch the balance
      expect(l.balance).toBe(0);
    } finally {
      await other.end();
    }
  });

  it("the same serialized race with a different payload is IDEMPOTENCY_KEY_REUSED", async () => {
    const f = await fixture();
    const other = await otherConnection();
    try {
      await other.query("BEGIN");
      await other.query(
        `INSERT INTO ledger_entry (kind, operator_id, pool_id, created_by_id, units, effective_at, idempotency_key)
         VALUES ('ALLOCATION', $1, $2, $1, 10, $3, 'k-unique-race-2')`,
        [f.operatorId, f.poolId, T0],
      );
      const pending = allocate(deps(T0, { lockTimeoutMs: 8000 }), input(f.operatorId, 99, "k-unique-race-2"));
      await waitUntilSomeBackendWaitsOnALock();
      await other.query("COMMIT");

      expect(await pending).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
      expect((await ledger(f.poolId)).count).toBe(1);
    } finally {
      await other.end();
    }
  });
});

describe("allocate: unique-violation backstop", () => {
  it("catches a unique violation that the pool lock can't prevent (same creator and key, different pool) and applies the payload check", async () => {
    // The unique index is per creator, not per pool, so two pools don't serialize each other.
    // Writer B (uncommitted) inserts (creator X, key K) into pool P2 for operator Y; the service then
    // allocates for operator X (pool P1) with the same key. Its insert waits on B, then hits
    // a unique violation, which Postgres reports by aborting the transaction. We catch it outside,
    // read the existing row, and the payload differs (operator Y vs X) -> 409, not a 500.
    const p1 = await fixture();
    const p2 = await fixture();
    const other = await otherConnection();
    try {
      await other.query("BEGIN");
      await other.query(
        `INSERT INTO ledger_entry (kind, operator_id, pool_id, created_by_id, units, effective_at, idempotency_key)
         VALUES ('ALLOCATION', $1, $2, $3, 10, $4, 'k-cross-pool')`,
        [p2.operatorId, p2.poolId, p1.operatorId, T0],
      );

      const pending = allocate(deps(T0, { lockTimeoutMs: 8000 }), input(p1.operatorId, 10, "k-cross-pool"));
      await waitUntilSomeBackendWaitsOnALock();
      await other.query("COMMIT");

      expect(await pending).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
      // the service's own transaction rolled back completely: nothing in P1, balance untouched
      expect(await ledger(p1.poolId)).toMatchObject({ count: 0, balance: 0 });
    } finally {
      await other.end();
    }
  });
});

describe("allocate: capacity (measured in ACTIVE units)", () => {
  it("allows filling exactly to capacity and rejects the next unit", async () => {
    const f = await fixture({ capacity: 100 });
    expect(await allocate(deps(T0), input(f.operatorId, 90, "c-1"))).toMatchObject({ ok: true });
    expect(await allocate(deps(T0), input(f.operatorId, 10, "c-2"))).toMatchObject({ ok: true }); // exactly 100
    expect(await allocate(deps(T0), input(f.operatorId, 1, "c-3"))).toEqual({ ok: false, reason: "CAPACITY_EXCEEDED" });
    expect(await ledger(f.poolId)).toMatchObject({ count: 2, sum: 100, balance: 100 });
  });

  it("expired units no longer hold capacity (the cached balance still includes them)", async () => {
    const f = await fixture({ capacity: 100, expiryMinutes: 60 });
    await allocate(deps(T0), input(f.operatorId, 90, "e-1"));

    // 30 minutes later the 90 units are still active: 20 more doesn't fit
    expect(await allocate(deps(minutes(T0, 30)), input(f.operatorId, 20, "e-2"))).toEqual({
      ok: false,
      reason: "CAPACITY_EXCEEDED",
    });
    // at exactly 60 minutes the first allocation has expired (boundary rule), so 90 fits again
    const later = await allocate(deps(minutes(T0, 60)), input(f.operatorId, 90, "e-3"));
    expect(later).toMatchObject({ ok: true, replay: false });

    const l = await ledger(f.poolId);
    expect(l.balance).toBe(180); // lifetime total: includes the expired 90
    expect(await getActiveUnits(db, f.poolId, minutes(T0, 60))).toBe(90);
  });

  it("a replay of an already accepted allocation still succeeds when the pool has since filled up", async () => {
    const f = await fixture({ capacity: 100 });
    const first = await allocate(deps(T0), input(f.operatorId, 60, "full-1"));
    await allocate(deps(T0), input(f.operatorId, 40, "full-2")); // now exactly full

    const replay = await allocate(deps(T0), input(f.operatorId, 60, "full-1"));
    expect(replay).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !replay.ok) throw new Error("unreachable");
    expect(replay.entry.seq).toBe(first.entry.seq);
  });

  it("no capacity limit (null) accepts large allocations", async () => {
    const f = await fixture({ capacity: null });
    expect(await allocate(deps(T0), input(f.operatorId, 1_000_000, "u-1"))).toMatchObject({ ok: true });
  });

  it("concurrent allocations can never push active units past capacity", async () => {
    const f = await fixture({ capacity: 50 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => allocate(deps(T0), input(f.operatorId, 10, `cap-race-${i}`))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === "CAPACITY_EXCEEDED")).toHaveLength(5);
    expect(await ledger(f.poolId)).toMatchObject({ count: 5, sum: 50, balance: 50 });
  });

  it("the SQL active-units sum agrees with the domain activeBalance at every boundary", async () => {
    const f = await fixture({ expiryMinutes: 60 });
    await allocate(deps(T0), input(f.operatorId, 10, "s-1"));
    await allocate(deps(minutes(T0, 20)), input(f.operatorId, 20, "s-2"));
    await allocate(deps(minutes(T0, 60)), input(f.operatorId, 40, "s-3")); // hand-over: s-1 expires as this starts
    await allocate(deps(minutes(T0, 100)), input(f.operatorId, 5, "s-4"));

    const entries: DomainEntry[] = (await ledger(f.poolId)).rows.map((r) => ({
      seq: r.seq,
      kind: r.kind,
      units: r.units,
      effectiveAt: r.effectiveAt,
      expiresAt: r.expiresAt,
      refSeq: r.refSeq,
    }));
    for (const m of [-1, 0, 19, 20, 59, 60, 61, 79, 80, 99, 100, 120, 160, 500]) {
      const at = minutes(T0, m);
      expect(await getActiveUnits(db, f.poolId, at), `at T0+${m}min`).toBe(activeBalance(entries, at));
    }
  });
});

describe("allocate: timeouts return BUSY and are safe to retry with the same key", () => {
  it("lock_timeout: BUSY while another transaction holds the pool lock; the retry then succeeds once", async () => {
    const f = await fixture();
    const holder = await otherConnection();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM pool WHERE id = $1 FOR UPDATE", [f.poolId]);

      const started = Date.now();
      const result = await allocate(deps(T0, { lockTimeoutMs: 200 }), input(f.operatorId, 5, "k-busy"));
      expect(result).toEqual({ ok: false, reason: "BUSY" });
      expect(Date.now() - started).toBeLessThan(3000);
      expect((await ledger(f.poolId)).count).toBe(0);

      await holder.query("ROLLBACK");
      const retry = await allocate(deps(T0), input(f.operatorId, 5, "k-busy"));
      expect(retry).toMatchObject({ ok: true, replay: false });
      expect(await ledger(f.poolId)).toMatchObject({ count: 1, balance: 5 });
    } finally {
      await holder.end();
    }
  });

  it("transaction timeout: BUSY too, and nothing is left behind", async () => {
    const f = await fixture();
    const holder = await otherConnection();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM pool WHERE id = $1 FOR UPDATE", [f.poolId]);

      // lock wait (5s) is longer than the whole-transaction budget (300ms), so the transaction timeout fires first
      const result = await allocate(deps(T0, { lockTimeoutMs: 5000, txTimeoutMs: 300 }), input(f.operatorId, 5, "k-tx"));
      expect(result).toEqual({ ok: false, reason: "BUSY" });

      await holder.query("ROLLBACK");
      await sleep(200);
      expect((await ledger(f.poolId)).count).toBe(0);

      const retry = await allocate(deps(T0), input(f.operatorId, 5, "k-tx"));
      expect(retry).toMatchObject({ ok: true, replay: false });
      expect(await ledger(f.poolId)).toMatchObject({ count: 1, balance: 5 });
    } finally {
      await holder.end();
    }
  });
});
