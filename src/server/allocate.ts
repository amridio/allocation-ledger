import { fitsCapacity, isSamePayload, type AllocateInput } from "@/domain/allocation";
import { computeExpiresAt } from "@/domain/expiry";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { AllocateResult, AllocationEntry } from "./allocate-types";

export interface AllocateDeps {
  db: PrismaClient;
  /** Injected so the service (and its tests) never read the clock directly. */
  clock: () => Date;
  /** How long to wait for the pool row lock before giving up with BUSY. Default 3s. */
  lockTimeoutMs?: number;
  /** Budget for the whole transaction. Default 5s. */
  txTimeoutMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const DEFAULT_TX_TIMEOUT_MS = 5_000;

type Queryable = Pick<PrismaClient, "$queryRaw">;

/**
 * ACTIVE units in a pool at `at`: entries with effective_at <= at and (expires_at is null or
 * expires_at > at). This is the SQL twin of `activeBalance` in src/domain/ledger.ts and uses
 * the same half-open rule; an integration test keeps the two in agreement.
 * Uses index ledger_entry(pool_id, expires_at).
 */
export async function getActiveUnits(client: Queryable, poolId: string, at: Date): Promise<number> {
  const rows = await client.$queryRaw<{ active: number }[]>`
    SELECT COALESCE(SUM(units), 0)::int AS active
    FROM ledger_entry
    WHERE pool_id = ${poolId}
      AND effective_at <= ${at}
      AND (expires_at IS NULL OR expires_at > ${at})`;
  return rows[0]?.active ?? 0;
}

/**
 * Log an allocation. One transaction (READ COMMITTED), in this order:
 *
 *   1. lock_timeout / statement_timeout for this transaction only
 *   2. lock the pool row (SELECT ... FOR UPDATE). A concurrent request for the same pool,
 *      including one with the same idempotency key, waits here.
 *   3. look up the idempotency key. This is the authoritative check, so it must come AFTER
 *      the lock: under READ COMMITTED it now sees whatever the previous lock holder committed.
 *      It also comes BEFORE the capacity check, so a replay of an accepted allocation is never
 *      refused just because the pool has filled up since.
 *   4. capacity check against ACTIVE units (not the cached balance)
 *   5. insert the ledger row, then balance = balance + n (atomic increment)
 *
 * Backstop: the unique index (created_by_id, idempotency_key). If an insert still collides
 * (a writer that did not take the pool lock), Postgres aborts the transaction, so we catch the
 * error OUTSIDE it, read the existing row with a fresh query, and apply the same payload check.
 *
 * Lock and transaction timeouts return BUSY. Nothing was written, so retrying with the same
 * idempotency key is safe.
 */
export async function allocate(deps: AllocateDeps, input: AllocateInput): Promise<AllocateResult> {
  const { db, clock } = deps;
  const lockTimeoutMs = deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const txTimeoutMs = deps.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
  const createdById = input.operatorId; // operators log their own allocations
  const key = { createdById_idempotencyKey: { createdById, idempotencyKey: input.idempotencyKey } };
  const requested = { operatorId: input.operatorId, kind: "ALLOCATION", units: input.units, refSeq: null } as const;

  const replayOf = (existing: AllocationEntry): AllocateResult =>
    isSamePayload(existing, requested)
      ? { ok: true, replay: true, entry: existing }
      : { ok: false, reason: "IDEMPOTENCY_KEY_REUSED" };

  try {
    return await db.$transaction(
      async (tx): Promise<AllocateResult> => {
        // 1. timeouts, local to this transaction (set_config(..., true) == SET LOCAL, but parameterized)
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${txTimeoutMs}ms`}, true)`;

        const operator = await tx.operator.findUnique({
          where: { id: input.operatorId },
          include: { tier: true },
        });
        if (!operator) return { ok: false, reason: "OPERATOR_NOT_FOUND" };

        // 2. lock the pool row
        const locked = await tx.$queryRaw<{ capacity: number | null }[]>`
          SELECT capacity FROM pool WHERE id = ${operator.poolId} FOR UPDATE`;
        const pool = locked[0];
        if (!pool) throw new Error(`Pool ${operator.poolId} vanished (operator FK should prevent this)`);

        // 3. idempotency
        const existing = await tx.ledgerEntry.findUnique({ where: key });
        if (existing) return replayOf(existing);

        // 4. capacity, in active units
        const now = clock();
        const activeUnits = await getActiveUnits(tx, operator.poolId, now);
        if (!fitsCapacity({ capacity: pool.capacity, activeUnits, units: input.units })) {
          return { ok: false, reason: "CAPACITY_EXCEEDED" };
        }

        // 5. insert + atomic balance increment
        const entry = await tx.ledgerEntry.create({
          data: {
            kind: "ALLOCATION",
            operatorId: operator.id,
            poolId: operator.poolId,
            createdById,
            units: input.units,
            effectiveAt: now,
            expiresAt: computeExpiresAt(now, operator.tier.expiryMinutes),
            idempotencyKey: input.idempotencyKey,
          },
        });
        await tx.pool.update({ where: { id: operator.poolId }, data: { balance: { increment: input.units } } });
        return { ok: true, replay: false, entry };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: txTimeoutMs,
        maxWait: 2_000,
      },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.ledgerEntry.findUnique({ where: key });
      if (existing) return replayOf(existing);
    }
    if (isBusy(err)) return { ok: false, reason: "BUSY" };
    throw err;
  }
}

/** Flattens an error (and its causes / meta) into one searchable string, whatever shape the driver adapter gives it. */
function errorText(err: unknown, depth = 0): string {
  if (depth > 6 || err === null || err === undefined) return "";
  if (typeof err === "string" || typeof err === "number") return String(err);
  if (typeof err !== "object") return "";
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  for (const value of Object.values(err)) parts.push(errorText(value, depth + 1));
  if ("cause" in err) parts.push(errorText((err as { cause?: unknown }).cause, depth + 1));
  return parts.join(" ");
}

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return true;
  return /\b23505\b/.test(errorText(err));
}

/** Lock timeout (55P03), statement timeout (57014), or Prisma's own transaction timeout / expiry (P2028). */
function isBusy(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028") return true;
  return /\b(55P03|57014)\b|lock timeout|statement timeout/i.test(errorText(err));
}
