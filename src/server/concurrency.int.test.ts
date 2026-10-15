import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEntry } from "./api/entries";
import {
  T0,
  db,
  fixture,
  ledger,
  otherConnection,
  sleep,
} from "./testing/int-helpers";

/*
 * The money-critical guarantees, at full size, with nothing mocked: real HTTP handlers (cookie,
 * Idempotency-Key header, Zod), the real services, the real Docker Postgres. Every scenario runs
 * several rounds, each on a brand-new pool, because one lucky interleaving proves nothing.
 *
 *   1. 50 parallel allocations            -> pool balance == sum of the ledger
 *   2. 20 parallel allocations that would
 *      overflow a nearly full pool        -> balance never exceeds capacity (watched DURING the run)
 *   3. the same Idempotency-Key, 5 at once -> exactly one row
 */

const ROUNDS = [1, 2, 3, 4, 5];
const ctx = () => ({ db, clock: () => T0 });

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
});
afterAll(async () => {
  await db.$disconnect();
});

const allocateRequest = (operatorId: string, units: number, key: string) =>
  new Request("http://localhost/api/entries", {
    method: "POST",
    headers: { cookie: `uid=${operatorId}`, "Idempotency-Key": key, "content-type": "application/json" },
    body: JSON.stringify({ units }),
  });

/** Fire every request in the same tick so they genuinely contend. */
const fireAll = (requests: Request[]) => Promise.all(requests.map((r) => createEntry(r, ctx())));

/** The invariant behind every guarantee: the cached balance is exactly the sum of the ledger. */
async function expectBalanceMatchesLedger(poolId: string) {
  const l = await ledger(poolId);
  expect(l.balance, "pool balance vs sum of ledger rows").toBe(l.sum);
  return l;
}

describe("1. 50 parallel allocations", () => {
  it.each(ROUNDS)("round %i: all 50 land, 50 rows, balance == sum of the ledger", async (round) => {
    const f = await fixture({ capacity: null, expiryMinutes: null });
    const unitsFor = (i: number) => i + 1; // 1..50, so a lost or doubled write changes the sum
    const responses = await fireAll(
      Array.from({ length: 50 }, (_, i) => allocateRequest(f.operatorId, unitsFor(i), `r${round}-all-${i}`)),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(201));
    const l = await expectBalanceMatchesLedger(f.poolId);
    expect(l.count).toBe(50);
    expect(l.sum).toBe((50 * 51) / 2); // 1275
    expect(new Set(l.rows.map((r) => r.seq)).size).toBe(50);
    expect(new Set(l.rows.map((r) => r.idempotencyKey)).size).toBe(50);
  });
});

describe("2. 20 parallel requests that would overflow a nearly full pool", () => {
  // capacity 100, 90 already used: only floor(10 / units) of the 20 requests can possibly fit
  it.each([
    [1, 5],
    [2, 7],
    [3, 3],
    [4, 10],
    [5, 4],
  ])("round %i: %i-unit requests, balance never exceeds capacity", async (round, units) => {
    const CAPACITY = 100;
    const f = await fixture({ capacity: CAPACITY, expiryMinutes: null });
    const seed = await createEntry(allocateRequest(f.operatorId, 90, `r${round}-seed`), ctx());
    expect(seed.status).toBe(201);

    // Watch the pool balance from a SEPARATE connection for the whole run, not just at the end.
    const watcher = await otherConnection();
    let stop = false;
    let maxSeen = 0;
    let samples = 0;
    const watching = (async () => {
      while (!stop) {
        const { rows } = await watcher.query<{ balance: number }>("SELECT balance FROM pool WHERE id = $1", [f.poolId]);
        maxSeen = Math.max(maxSeen, rows[0]?.balance ?? 0);
        samples++;
        await sleep(1);
      }
    })();

    let responses: Response[];
    try {
      responses = await fireAll(
        Array.from({ length: 20 }, (_, i) => allocateRequest(f.operatorId, units, `r${round}-over-${i}`)),
      );
    } finally {
      stop = true;
      await watching;
      await watcher.end();
    }

    const statuses = responses.map((r) => r.status);
    const accepted = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 422).length;
    const fits = Math.floor((CAPACITY - 90) / units);

    expect(statuses.filter((s) => s !== 201 && s !== 422), "no 5xx / other statuses").toEqual([]);
    expect(accepted).toBe(fits); // exactly as many as fit: not one more, not one fewer
    expect(rejected).toBe(20 - fits);
    for (const r of responses.filter((x) => x.status === 422)) {
      expect(await r.json()).toMatchObject({ error: "CAPACITY_EXCEEDED" });
    }

    expect(samples, "the watcher actually observed the run").toBeGreaterThan(0);
    expect(maxSeen, "highest balance ever observed during the run").toBeLessThanOrEqual(CAPACITY);
    const l = await expectBalanceMatchesLedger(f.poolId);
    expect(l.balance).toBeLessThanOrEqual(CAPACITY);
    expect(l.balance).toBe(90 + fits * units);
    expect(l.count).toBe(1 + fits);
  });
});

describe("3. the same Idempotency-Key 5 times in parallel", () => {
  it.each(ROUNDS)("round %i: exactly one row, one balance change, everyone gets the same entry", async (round) => {
    const f = await fixture({ capacity: null, expiryMinutes: null });
    const responses = await fireAll(
      Array.from({ length: 5 }, () => allocateRequest(f.operatorId, 25, `r${round}-same-key`)),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]); // one created, four replays
    const seqs = new Set((await Promise.all(responses.map((r) => r.json()))).map((b) => b.entry.seq));
    expect(seqs.size).toBe(1);

    const l = await expectBalanceMatchesLedger(f.poolId);
    expect(l).toMatchObject({ count: 1, sum: 25, balance: 25 });
  });
});
