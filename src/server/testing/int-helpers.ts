// Shared by *.int.test.ts. Not a test file itself, and never imported by app code.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDb } from "../db-client";
import { assertSafeTestDatabase } from "./test-db-guard";

try {
  process.loadEnvFile();
} catch {
  // rely on the real environment
}
export const TEST_URL = process.env["TEST_DATABASE_URL"] ?? "";
assertSafeTestDatabase(TEST_URL, process.env["DATABASE_URL"]); // never let a test touch dev data

// 20 connections by default so 50 parallel requests can queue; TEST_DATABASE_POOL_SIZE lets you try smaller pools.
export const db = createDb(TEST_URL, { max: Number(process.env["TEST_DATABASE_POOL_SIZE"] ?? 20) });
export const T0 = new Date("2026-03-01T09:00:00.000Z");
export const minutes = (base: Date, m: number) => new Date(base.getTime() + m * 60_000);
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The ledger is append-only, so tests can't clean up: every test gets its own tier, pool and operator. */
export async function fixture(opts: { capacity?: number | null; expiryMinutes?: number | null } = {}) {
  const id = randomUUID().slice(0, 8);
  const tier = await db.tier.create({
    data: { name: `tier-${id}`, expiryMinutes: opts.expiryMinutes === undefined ? 60 : opts.expiryMinutes },
  });
  const pool = await db.pool.create({ data: { name: `pool-${id}`, capacity: opts.capacity ?? null } });
  const operator = await db.operator.create({ data: { name: `op-${id}`, tierId: tier.id, poolId: pool.id } });
  return { tierId: tier.id, poolId: pool.id, operatorId: operator.id };
}

/** A SUPERVISOR living in the given pool (supervisors are operators with role SUPERVISOR). */
export async function supervisorIn(f: { tierId: string; poolId: string }) {
  const s = await db.operator.create({
    data: { name: `sup-${randomUUID().slice(0, 8)}`, role: "SUPERVISOR", tierId: f.tierId, poolId: f.poolId },
  });
  return s.id;
}

export const deps = (now: Date = T0, extra: { lockTimeoutMs?: number; txTimeoutMs?: number } = {}) => ({
  db,
  clock: () => now,
  ...extra,
});

export async function ledger(poolId: string) {
  const rows = await db.ledgerEntry.findMany({ where: { poolId }, orderBy: { seq: "asc" } });
  const pool = await db.pool.findUniqueOrThrow({ where: { id: poolId } });
  return { rows, count: rows.length, sum: rows.reduce((s, r) => s + r.units, 0), balance: pool.balance };
}

/** Opens a second connection holding a lock / uncommitted work, to create races on purpose. */
export async function otherConnection() {
  const client = new pg.Client({ connectionString: TEST_URL });
  await client.connect();
  return client;
}

export async function waitUntilSomeBackendWaitsOnALock() {
  for (let i = 0; i < 100; i++) {
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((rows[0]?.n ?? 0) > 0) return;
    await sleep(50);
  }
  throw new Error("no backend ever started waiting on a lock");
}
