import { Prisma, type PrismaClient } from "@/generated/prisma/client";

/** What every ledger write service needs. Time is injected; nothing here reads the clock. */
export interface LedgerTxDeps {
  db: PrismaClient;
  clock: () => Date;
  /** How long to wait for the pool row lock before giving up with BUSY. Default 3s. */
  lockTimeoutMs?: number;
  /** Budget for the whole transaction. Default 5s. */
  txTimeoutMs?: number;
}

export type Tx = Prisma.TransactionClient;

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

/** SELECT ... FOR UPDATE on the pool row. Anything else touching this pool's ledger waits here. */
export async function lockPool(tx: Tx, poolId: string): Promise<{ capacity: number | null }> {
  const rows = await tx.$queryRaw<{ capacity: number | null }[]>`
    SELECT capacity FROM pool WHERE id = ${poolId} FOR UPDATE`;
  const pool = rows[0];
  if (!pool) throw new Error(`Pool ${poolId} not found (the operator foreign key should make this impossible)`);
  return pool;
}

/**
 * Runs `body` in one READ COMMITTED transaction with lock_timeout and statement_timeout set for
 * this transaction only, plus Prisma's own whole-transaction timeout.
 *
 * Two failures are handled here so every ledger write behaves the same way:
 *  - Unique violation (idempotency backstop). Postgres aborts the transaction, so it is caught
 *    OUTSIDE it; `recover` then answers with a fresh query (return undefined to rethrow).
 *  - Lock / statement / transaction timeout: returns `onBusy`. Nothing was written, so retrying
 *    with the same idempotency key is safe.
 */
export async function runLedgerTransaction<T>(
  deps: LedgerTxDeps,
  body: (tx: Tx) => Promise<T>,
  recover: () => Promise<T | undefined>,
  onBusy: T,
): Promise<T> {
  const lockTimeoutMs = deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const txTimeoutMs = deps.txTimeoutMs ?? DEFAULT_TX_TIMEOUT_MS;
  try {
    return await deps.db.$transaction(
      async (tx) => {
        // set_config(..., true) == SET LOCAL, but parameterized
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`;
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${txTimeoutMs}ms`}, true)`;
        return body(tx);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: txTimeoutMs,
        maxWait: 2_000,
      },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      const recovered = await recover();
      if (recovered !== undefined) return recovered;
    }
    if (isBusy(err)) return onBusy;
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
