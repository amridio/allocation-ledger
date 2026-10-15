import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adjust } from "./adjust";
import { allocate } from "./allocate";
import type { SessionUser } from "./api/auth";
import { loadDashboard } from "./dashboard";
import { T0, db, deps, fixture, minutes, supervisorIn } from "./testing/int-helpers";

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  await db.$disconnect();
});

async function site() {
  const f = await fixture({ expiryMinutes: 60 });
  const op2 = await db.operator.create({ data: { name: "Ben", tierId: f.tierId, poolId: f.poolId } });
  const supId = await supervisorIn(f);
  const far = await fixture();
  const farSup = await supervisorIn(far);
  const give = async (operatorId: string, units: number, key: string, at: Date = T0) => {
    const r = await allocate(deps(at), { operatorId, units, idempotencyKey: key });
    if (!r.ok) throw new Error("setup failed");
    return r.entry;
  };
  const user = async (id: string): Promise<SessionUser> => {
    const o = await db.operator.findUniqueOrThrow({ where: { id } });
    return { id: o.id, name: o.name, role: o.role, poolId: o.poolId };
  };
  return { f, op1: f.operatorId, op2: op2.id, sup: supId, farOp: far.operatorId, farSup, give, user };
}

describe("loadDashboard: what the server renders on first open", () => {
  it("an operator gets their own metric, their own entries and the transitions view; no operator picker", async () => {
    const s = await site();
    await s.give(s.op1, 30, "d-1");
    await s.give(s.op2, 99, "d-2");
    const data = await loadDashboard(db, await s.user(s.op1), undefined, minutes(T0, 5));

    expect(data.subject).toMatchObject({ id: s.op1 });
    expect(data.operators).toBeNull();
    expect(data.metric.operator).toMatchObject({ id: s.op1, activeUnits: 30, status: "LOW" });
    expect(data.entries.entries.map((e) => e.operatorId)).toEqual([s.op1]);
    expect(data.timeline).toMatchObject({ operatorId: s.op1, view: "transitions" });
    expect(data.entriesScope).toBe("self");
  });

  it("an operator can't steer it to someone else: a requested operator is ignored", async () => {
    const s = await site();
    await s.give(s.op2, 99, "d-3");
    const data = await loadDashboard(db, await s.user(s.op1), s.op2, T0);
    expect(data.subject.id).toBe(s.op1);
    expect(JSON.stringify(data)).not.toContain('"units":99');
  });

  it("a supervisor gets the pool's operators, the pool-wide log, and the full timeline of the selected operator", async () => {
    const s = await site();
    await s.give(s.op1, 30, "d-4");
    await s.give(s.op2, 40, "d-5");
    await s.give(s.farOp, 777, "d-far");
    const data = await loadDashboard(db, await s.user(s.sup), s.op2, minutes(T0, 5));

    expect(data.subject).toMatchObject({ id: s.op2, name: "Ben" });
    expect(data.operators?.map((o) => o.id).sort()).toEqual([s.op1, s.op2, s.sup].sort());
    expect(data.entries.entries.map((e) => e.units).sort()).toEqual([30, 40]);
    expect(data.entriesScope).toBe("pool");
    expect(data.metric.operator).toMatchObject({ id: s.op2, activeUnits: 40 });
    expect(data.timeline).toMatchObject({ operatorId: s.op2, view: "full" });
  });

  it("a supervisor defaults to the first operator (by name) when none is selected, never to themselves", async () => {
    const s = await site(); // pool operators: "Ben" and a generated "op-..." one; "Ben" sorts first
    const data = await loadDashboard(db, await s.user(s.sup), undefined, T0);
    expect(data.subject).toMatchObject({ id: s.op2, name: "Ben" });
    expect(data.subject.id).not.toBe(s.sup);
  });

  it("a supervisor can't select an operator at another site: it falls back to the default and nothing from the other site leaks", async () => {
    const s = await site();
    await s.give(s.farOp, 777, "d-far-2");
    const data = await loadDashboard(db, await s.user(s.sup), s.farOp, T0);
    expect(data.subject.id).not.toBe(s.farOp);
    expect(data.operators?.map((o) => o.id)).not.toContain(s.farOp);
    expect(JSON.stringify(data)).not.toContain("777");
    // and an id that doesn't exist behaves the same
    const unknown = await loadDashboard(db, await s.user(s.sup), "no-such-operator", T0);
    expect(unknown.subject.id).toBe(data.subject.id);
  });

  it("everything it returns is plain JSON (ISO date strings), identical to what the API would send", async () => {
    const s = await site();
    const target = await s.give(s.op1, 30, "d-6");
    await adjust(deps(minutes(T0, 5)), { supervisorId: s.sup, targetSeq: target.seq, units: -10, reason: "r", idempotencyKey: "d-adj" });
    const data = await loadDashboard(db, await s.user(s.sup), s.op1, minutes(T0, 10));
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(data.entries.entries[0]?.effectiveAt).toBe(T0.toISOString());
    expect(data.metric.asOf).toBe(minutes(T0, 10).toISOString());
    expect(data.metric.nextExpiryAt).toBe(minutes(T0, 60).toISOString());
  });
});
