import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeBalance, statusTimeline, type DomainEntry } from "@/domain/ledger";
import { adjust } from "./adjust";
import { allocate } from "./allocate";
import {
  T0,
  db,
  deps,
  fixture,
  ledger,
  minutes,
  otherConnection,
  supervisorIn,
  waitUntilSomeBackendWaitsOnALock,
} from "./testing/int-helpers";

/** A pool with one operator, one supervisor, and one allocation of `units` made at `at`. */
async function setup(opts: { capacity?: number | null; expiryMinutes?: number | null; units?: number; at?: Date } = {}) {
  const f = await fixture(opts);
  const sup = await supervisorIn(f);
  const made = await allocate(deps(opts.at ?? T0), {
    operatorId: f.operatorId,
    units: opts.units ?? 30,
    idempotencyKey: `alloc-${f.operatorId}`,
  });
  if (!made.ok) throw new Error("setup allocation failed");
  return { ...f, sup, target: made.entry };
}
const adjustInput = (sup: string, targetSeq: number, units: number, key: string, reason = "Miscount at pickup") => ({
  supervisorId: sup,
  targetSeq,
  units,
  reason,
  idempotencyKey: key,
});
const toDomain = (rows: Awaited<ReturnType<typeof ledger>>["rows"]): DomainEntry[] =>
  rows.map((r) => ({ seq: r.seq, kind: r.kind, units: r.units, effectiveAt: r.effectiveAt, expiresAt: r.expiresAt, refSeq: r.refSeq }));

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  await db.$disconnect();
});

describe("adjust: basics", () => {
  it("creates an ADJUSTMENT that points at the target and copies its effectiveAt and expiresAt", async () => {
    const s = await setup({ units: 30, expiryMinutes: 60 });
    // the supervisor acts 30 minutes later: the adjustment must still be dated at the target's time
    const result = await adjust(deps(minutes(T0, 30)), adjustInput(s.sup, s.target.seq, -10, "a-1"));

    expect(result).toMatchObject({ ok: true, replay: false });
    if (!result.ok) throw new Error("unreachable");
    expect(result.entry).toMatchObject({
      kind: "ADJUSTMENT",
      operatorId: s.operatorId,
      poolId: s.poolId,
      createdById: s.sup,
      units: -10,
      refSeq: s.target.seq,
      reason: "Miscount at pickup",
    });
    expect(result.entry.effectiveAt).toEqual(s.target.effectiveAt);
    expect(result.entry.effectiveAt).toEqual(T0);
    expect(result.entry.expiresAt).toEqual(s.target.expiresAt);
    expect(result.entry.expiresAt).toEqual(minutes(T0, 60));
    expect(result.entry.recordedAt.getTime()).toBeGreaterThan(0);
    expect(await ledger(s.poolId)).toMatchObject({ count: 2, sum: 20, balance: 20 });
  });

  it("a never-expiring target gives a never-expiring adjustment", async () => {
    const s = await setup({ expiryMinutes: null });
    const result = await adjust(deps(), adjustInput(s.sup, s.target.seq, 5, "a-never"));
    expect(result.ok && result.entry.expiresAt).toBeNull();
  });

  it("a positive adjustment raises the balance", async () => {
    const s = await setup({ units: 30 });
    await adjust(deps(), adjustInput(s.sup, s.target.seq, 12, "a-up"));
    expect(await ledger(s.poolId)).toMatchObject({ count: 2, sum: 42, balance: 42 });
  });

  it("end to end with the domain functions: the adjustment changes the target's moment and drops out with it", async () => {
    const s = await setup({ units: 30, expiryMinutes: 60 });
    await adjust(deps(minutes(T0, 30)), adjustInput(s.sup, s.target.seq, -10, "a-e2e"));
    const entries = toDomain((await ledger(s.poolId)).rows);

    expect(activeBalance(entries, minutes(T0, 10))).toBe(20);
    expect(activeBalance(entries, minutes(T0, 60))).toBe(0); // both expire together: no -10 residue
    expect(statusTimeline(entries)).toEqual([
      { at: T0, balance: 20, status: "LOW" },
      { at: minutes(T0, 60), balance: 0, status: "CRITICAL" },
    ]);
  });
});

describe("adjust: who and what", () => {
  const unchanged = async (s: Awaited<ReturnType<typeof setup>>) =>
    expect(await ledger(s.poolId)).toMatchObject({ count: 1, sum: 30, balance: 30 });

  it("NOT_SUPERVISOR when an operator tries; nothing is written", async () => {
    const s = await setup();
    expect(await adjust(deps(), adjustInput(s.operatorId, s.target.seq, -5, "w-1"))).toEqual({
      ok: false,
      reason: "NOT_SUPERVISOR",
    });
    await unchanged(s);
  });

  it("SUPERVISOR_NOT_FOUND for an unknown user", async () => {
    const s = await setup();
    expect(await adjust(deps(), adjustInput("nobody", s.target.seq, -5, "w-2"))).toEqual({
      ok: false,
      reason: "SUPERVISOR_NOT_FOUND",
    });
    await unchanged(s);
  });

  it("TARGET_NOT_FOUND for an unknown entry", async () => {
    const s = await setup();
    expect(await adjust(deps(), adjustInput(s.sup, 2_000_000_000, -5, "w-3"))).toEqual({
      ok: false,
      reason: "TARGET_NOT_FOUND",
    });
    await unchanged(s);
  });

  it("TARGET_NOT_ALLOCATION when the target is itself an adjustment (adjust the original instead)", async () => {
    const s = await setup();
    const first = await adjust(deps(), adjustInput(s.sup, s.target.seq, -5, "w-4"));
    if (!first.ok) throw new Error("unreachable");
    expect(await adjust(deps(), adjustInput(s.sup, first.entry.seq, -1, "w-5"))).toEqual({
      ok: false,
      reason: "TARGET_NOT_ALLOCATION",
    });
    expect((await ledger(s.poolId)).count).toBe(2);
  });

  it("TARGET_OTHER_POOL when the target belongs to another pool: a supervisor can't change another site's numbers", async () => {
    const a = await setup(); // supervisor lives in pool A
    const b = await setup(); // target lives in pool B
    expect(await adjust(deps(), adjustInput(a.sup, b.target.seq, -4, "x-pool"))).toEqual({
      ok: false,
      reason: "TARGET_OTHER_POOL",
    });
    expect(await adjust(deps(), adjustInput(b.sup, a.target.seq, 4, "x-pool-2"))).toEqual({
      ok: false,
      reason: "TARGET_OTHER_POOL",
    });
    // neither pool changed, in the ledger or the cached balance
    expect(await ledger(a.poolId)).toMatchObject({ count: 1, sum: 30, balance: 30 });
    expect(await ledger(b.poolId)).toMatchObject({ count: 1, sum: 30, balance: 30 });
  });

  it("the pool check comes before everything else about the target, so an adjustment in another pool is 403, not 422", async () => {
    const a = await setup();
    const b = await setup();
    const inB = await adjust(deps(), adjustInput(b.sup, b.target.seq, -1, "x-pool-3"));
    if (!inB.ok) throw new Error("setup failed");
    expect(await adjust(deps(), adjustInput(a.sup, inB.entry.seq, -1, "x-pool-4"))).toEqual({
      ok: false,
      reason: "TARGET_OTHER_POOL",
    });
  });
});

describe("adjust: idempotency", () => {
  it("replays the original adjustment for the same key and payload; nothing changes", async () => {
    const s = await setup();
    const first = await adjust(deps(), adjustInput(s.sup, s.target.seq, -10, "i-1"));
    const second = await adjust(deps(minutes(T0, 5)), adjustInput(s.sup, s.target.seq, -10, "i-1"));

    expect(first).toMatchObject({ ok: true, replay: false });
    expect(second).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.entry.seq).toBe(first.entry.seq);
    expect(await ledger(s.poolId)).toMatchObject({ count: 2, sum: 20, balance: 20 });
  });

  it("the reason is not part of the payload check: a retry with reworded text is still a replay of the original", async () => {
    const s = await setup();
    await adjust(deps(), adjustInput(s.sup, s.target.seq, -10, "i-2", "first wording"));
    const retry = await adjust(deps(), adjustInput(s.sup, s.target.seq, -10, "i-2", "second wording"));
    expect(retry).toMatchObject({ ok: true, replay: true });
    expect(retry.ok && retry.entry.reason).toBe("first wording");
  });

  it("IDEMPOTENCY_KEY_REUSED for the same key with different units, or a different target", async () => {
    const s = await setup();
    const other = await allocate(deps(), { operatorId: s.operatorId, units: 5, idempotencyKey: "second-target" });
    if (!other.ok) throw new Error("unreachable");
    await adjust(deps(), adjustInput(s.sup, s.target.seq, -10, "i-3"));

    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -11, "i-3"))).toEqual({
      ok: false,
      reason: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(await adjust(deps(), adjustInput(s.sup, other.entry.seq, -10, "i-3"))).toEqual({
      ok: false,
      reason: "IDEMPOTENCY_KEY_REUSED",
    });
    expect((await ledger(s.poolId)).count).toBe(3); // two allocations + the one adjustment
  });

  it("an allocation and an adjustment sharing a key are different requests (kind differs)", async () => {
    const s = await setup();
    const asAllocation = await allocate(deps(), { operatorId: s.sup, units: 5, idempotencyKey: "same-key" });
    expect(asAllocation).toMatchObject({ ok: true });
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -1, "same-key"))).toEqual({
      ok: false,
      reason: "IDEMPOTENCY_KEY_REUSED",
    });
  });

  it("10 simultaneous requests with the SAME key and target produce exactly one adjustment", async () => {
    const s = await setup({ units: 30 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => adjust(deps(), adjustInput(s.sup, s.target.seq, -7, "i-race"))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.replay)).toHaveLength(1);
    expect(new Set(results.map((r) => (r.ok ? r.entry.seq : null))).size).toBe(1);
    expect(await ledger(s.poolId)).toMatchObject({ count: 2, sum: 23, balance: 23 });
  });

  it("10 simultaneous adjustments with DIFFERENT keys all land; balance equals the ledger sum", async () => {
    const s = await setup({ units: 100 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => adjust(deps(), adjustInput(s.sup, s.target.seq, -(i + 1), `i-par-${i}`))),
    );
    expect(results.every((r) => r.ok && !r.replay)).toBe(true);
    const l = await ledger(s.poolId);
    expect(l.count).toBe(11);
    expect(l.sum).toBe(100 - 55);
    expect(l.balance).toBe(l.sum);
  });

  it("the unique-violation backstop: same supervisor and key arriving for targets in two pools (no shared lock) -> 409, never a 500", async () => {
    // The unique index is per creator, not per pool, so pool locks don't serialize these two.
    const a = await setup();
    const b = await setup();
    const other = await otherConnection();
    try {
      // Writer B (uncommitted): an adjustment by supervisor `a.sup`, key K, against pool B's target.
      await other.query("BEGIN");
      await other.query(
        `INSERT INTO ledger_entry (kind, operator_id, pool_id, created_by_id, units, effective_at, expires_at, ref_seq, reason, idempotency_key)
         VALUES ('ADJUSTMENT', $1, $2, $3, -3, $4, $5, $6, 'other writer', 'k-cross')`,
        [b.operatorId, b.poolId, a.sup, b.target.effectiveAt, b.target.expiresAt, b.target.seq],
      );

      // Same supervisor and key, but the target is in pool A: different pool lock, so it doesn't wait on B's insert
      const pending = adjust(deps(T0, { lockTimeoutMs: 8000 }), adjustInput(a.sup, a.target.seq, -3, "k-cross"));
      await waitUntilSomeBackendWaitsOnALock(); // now blocked on the unique index
      await other.query("COMMIT");

      expect(await pending).toEqual({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED" });
      expect(await ledger(a.poolId)).toMatchObject({ count: 1, sum: 30, balance: 30 }); // rolled back completely
    } finally {
      await other.end();
    }
  });

  it("the same key can't be used to touch two pools: the second pool is refused before anything is written", async () => {
    // Since a supervisor can only act in their own pool, one creator + key always lands in one pool,
    // and the pool lock alone serializes them. The unique-index backstop above is for writers that
    // bypass this service.
    const a = await setup();
    const b = await setup();
    const ok = await adjust(deps(), adjustInput(a.sup, a.target.seq, -2, "k-two"));
    const refused = await adjust(deps(), adjustInput(a.sup, b.target.seq, -2, "k-two"));
    expect(ok).toMatchObject({ ok: true });
    expect(refused).toEqual({ ok: false, reason: "TARGET_OTHER_POOL" });
    expect(await ledger(b.poolId)).toMatchObject({ count: 1, balance: 30 });
  });
});

describe("adjust: over-correction (an entry's net units can't go below zero)", () => {
  it("allows reducing an entry to exactly zero, then refuses anything more", async () => {
    const s = await setup({ units: 30 });
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -20, "oc-1"))).toMatchObject({ ok: true }); // net 10
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -10, "oc-2"))).toMatchObject({ ok: true }); // net 0
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -1, "oc-3"))).toEqual({
      ok: false,
      reason: "ADJUSTMENT_BELOW_ZERO",
    });
    expect(await ledger(s.poolId)).toMatchObject({ count: 3, sum: 0, balance: 0 });
  });

  it("a single adjustment larger than the entry is refused and writes nothing", async () => {
    const s = await setup({ units: 30 });
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -31, "oc-4"))).toEqual({
      ok: false,
      reason: "ADJUSTMENT_BELOW_ZERO",
    });
    expect(await ledger(s.poolId)).toMatchObject({ count: 1, sum: 30, balance: 30 });
  });

  it("counts earlier positive adjustments, and adjustments on a different entry don't count", async () => {
    const s = await setup({ units: 30 });
    const other = await allocate(deps(), { operatorId: s.operatorId, units: 5, idempotencyKey: "other-entry" });
    if (!other.ok) throw new Error("setup failed");
    await adjust(deps(), adjustInput(s.sup, s.target.seq, 10, "oc-5")); // net 40
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -40, "oc-6"))).toMatchObject({ ok: true });
    // the other entry has its own total (5): -6 is too much for it even though the first is at 0
    expect(await adjust(deps(), adjustInput(s.sup, other.entry.seq, -6, "oc-7"))).toEqual({
      ok: false,
      reason: "ADJUSTMENT_BELOW_ZERO",
    });
    expect(await adjust(deps(), adjustInput(s.sup, other.entry.seq, -5, "oc-8"))).toMatchObject({ ok: true });
  });

  it("applies to expired entries too (their history still has to make sense)", async () => {
    const s = await setup({ units: 30, expiryMinutes: 60 });
    expect(await adjust(deps(minutes(T0, 500)), adjustInput(s.sup, s.target.seq, -31, "oc-9"))).toEqual({
      ok: false,
      reason: "ADJUSTMENT_BELOW_ZERO",
    });
  });

  it("a replay of an accepted adjustment still succeeds after later adjustments used up the entry", async () => {
    const s = await setup({ units: 30 });
    const first = await adjust(deps(), adjustInput(s.sup, s.target.seq, -20, "oc-10"));
    await adjust(deps(), adjustInput(s.sup, s.target.seq, -10, "oc-11")); // net 0
    const replay = await adjust(deps(), adjustInput(s.sup, s.target.seq, -20, "oc-10"));
    expect(replay).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !replay.ok) throw new Error("unreachable");
    expect(replay.entry.seq).toBe(first.entry.seq);
  });

  it("two supervisors adjusting the same entry at once can't both pass: the check runs inside the pool lock", async () => {
    for (let round = 0; round < 8; round++) {
      const s = await setup({ units: 30 });
      const second = await supervisorIn(s);
      // six simultaneous -10s from two supervisors against a 30-unit entry: exactly three can fit
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          adjust(deps(), adjustInput(i % 2 === 0 ? s.sup : second, s.target.seq, -10, `oc-race-${round}-${i}`)),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(results.filter((r) => !r.ok && r.reason === "ADJUSTMENT_BELOW_ZERO")).toHaveLength(3);
      const l = await ledger(s.poolId);
      expect(l.sum).toBe(0); // the entry ends at exactly zero, never negative
      expect(l.balance).toBe(0);
    }
  });
});

describe("adjust: capacity applies only to units that would be ACTIVE now", () => {
  it("a positive adjustment on a live target can fill the pool exactly, but not exceed it", async () => {
    const s = await setup({ capacity: 50, units: 40 });
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, 10, "c-1"))).toMatchObject({ ok: true }); // 50
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, 1, "c-2"))).toEqual({
      ok: false,
      reason: "CAPACITY_EXCEEDED",
    });
    expect(await ledger(s.poolId)).toMatchObject({ count: 2, sum: 50, balance: 50 });
  });

  it("a negative adjustment is always allowed, even in a full pool", async () => {
    const s = await setup({ capacity: 40, units: 40 });
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -15, "c-3"))).toMatchObject({ ok: true });
  });

  it("a positive adjustment on an EXPIRED target adds no active units, so it is allowed in a full pool", async () => {
    const s = await setup({ capacity: 50, units: 10, expiryMinutes: 60 }); // target expires at T0+60
    const fill = await allocate(deps(minutes(T0, 100)), { operatorId: s.operatorId, units: 50, idempotencyKey: "fill" });
    expect(fill).toMatchObject({ ok: true }); // pool is now full of ACTIVE units until T0+160

    const result = await adjust(deps(minutes(T0, 120)), adjustInput(s.sup, s.target.seq, 5, "c-4"));
    expect(result).toMatchObject({ ok: true, replay: false });
    const entries = toDomain((await ledger(s.poolId)).rows);
    expect(activeBalance(entries, minutes(T0, 120))).toBe(50); // unchanged: the +5 expired with its target
  });

  it("in a pool already OVER capacity (limit lowered), corrections that reduce or add no active usage still go through", async () => {
    const s = await setup({ capacity: 50, units: 40, expiryMinutes: 60 }); // target expires at T0+60
    await db.pool.update({ where: { id: s.poolId }, data: { capacity: 30 } }); // now 40 active vs capacity 30

    // reducing usage is exactly what a supervisor should be able to do
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -5, "o-1"))).toMatchObject({ ok: true });
    // adding usage is still refused
    expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, 1, "o-2"))).toEqual({
      ok: false,
      reason: "CAPACITY_EXCEEDED",
    });
    // later the target has expired: a positive adjustment on it adds no ACTIVE units, so it is fine
    expect(await adjust(deps(minutes(T0, 90)), adjustInput(s.sup, s.target.seq, 3, "o-3"))).toMatchObject({ ok: true });
  });

  it("a replay is not refused for capacity after the pool filled up", async () => {
    const s = await setup({ capacity: 50, units: 30 });
    const first = await adjust(deps(), adjustInput(s.sup, s.target.seq, 10, "c-5")); // 40
    await allocate(deps(), { operatorId: s.operatorId, units: 10, idempotencyKey: "fill-2" }); // 50: full
    const replay = await adjust(deps(), adjustInput(s.sup, s.target.seq, 10, "c-5"));
    expect(replay).toMatchObject({ ok: true, replay: true });
    if (!first.ok || !replay.ok) throw new Error("unreachable");
    expect(replay.entry.seq).toBe(first.entry.seq);
  });
});

describe("adjust: serializes with allocations on the same pool", () => {
  it("an operator's allocation and a supervisor's adjustment in the same pool can't both squeeze past capacity", async () => {
    for (let round = 0; round < 6; round++) {
      const s = await setup({ capacity: 50, units: 40 }); // 40 of 50 used

      // +10 from the operator and +10 from the supervisor: only one of them can fit
      const [allocation, adjustment] = await Promise.all([
        allocate(deps(), { operatorId: s.operatorId, units: 10, idempotencyKey: `race-a-${round}` }),
        adjust(deps(), adjustInput(s.sup, s.target.seq, 10, `race-j-${round}`)),
      ]);

      expect([allocation, adjustment].filter((r) => r.ok)).toHaveLength(1);
      expect([allocation, adjustment].filter((r) => !r.ok && r.reason === "CAPACITY_EXCEEDED")).toHaveLength(1);
      const l = await ledger(s.poolId);
      expect(l.sum).toBe(50);
      expect(l.balance).toBe(50);
    }
  });
});

describe("adjust: timeouts return BUSY and are safe to retry", () => {
  it("BUSY while another transaction holds the target's pool lock; the retry then succeeds once", async () => {
    const s = await setup();
    const holder = await otherConnection();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM pool WHERE id = $1 FOR UPDATE", [s.poolId]);
      const result = await adjust(deps(T0, { lockTimeoutMs: 200 }), adjustInput(s.sup, s.target.seq, -5, "b-1"));
      expect(result).toEqual({ ok: false, reason: "BUSY" });
      expect((await ledger(s.poolId)).count).toBe(1);

      await holder.query("ROLLBACK");
      expect(await adjust(deps(), adjustInput(s.sup, s.target.seq, -5, "b-1"))).toMatchObject({ ok: true, replay: false });
      expect(await ledger(s.poolId)).toMatchObject({ count: 2, balance: 25 });
    } finally {
      await holder.end();
    }
  });
});
