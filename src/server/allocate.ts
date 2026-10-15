import { fitsCapacity, isSamePayload, type AllocateInput } from "@/domain/allocation";
import { computeExpiresAt } from "@/domain/expiry";
import type { AllocateResult, LedgerEntryRecord } from "./ledger-types";
import { getActiveUnits, lockPool, runLedgerTransaction, type LedgerTxDeps } from "./ledger-tx";

export type AllocateDeps = LedgerTxDeps;

/**
 * Log an allocation. One transaction (see runLedgerTransaction), in this order:
 *
 *   1. lock the pool row (SELECT ... FOR UPDATE). A concurrent request for the same pool,
 *      including one with the same idempotency key, waits here.
 *   2. look up the idempotency key. This is the authoritative check, so it must come AFTER
 *      the lock: under READ COMMITTED it now sees whatever the previous lock holder committed.
 *      It also comes BEFORE the capacity check, so a replay of an accepted allocation is never
 *      refused just because the pool has filled up since.
 *   3. capacity check against ACTIVE units (not the cached balance)
 *   4. insert the ledger row, then balance = balance + n (atomic increment)
 *
 * Backstop: the unique index (created_by_id, idempotency_key), handled in runLedgerTransaction.
 */
export async function allocate(deps: AllocateDeps, input: AllocateInput): Promise<AllocateResult> {
  const { db, clock } = deps;
  const createdById = input.operatorId; // operators log their own allocations
  const key = { createdById_idempotencyKey: { createdById, idempotencyKey: input.idempotencyKey } };
  const requested = { operatorId: input.operatorId, kind: "ALLOCATION", units: input.units, refSeq: null } as const;

  const replayOf = (existing: LedgerEntryRecord): AllocateResult =>
    isSamePayload(existing, requested)
      ? { ok: true, replay: true, entry: existing }
      : { ok: false, reason: "IDEMPOTENCY_KEY_REUSED" };

  return runLedgerTransaction<AllocateResult>(
    deps,
    async (tx) => {
      const operator = await tx.operator.findUnique({ where: { id: input.operatorId }, include: { tier: true } });
      if (!operator) return { ok: false, reason: "OPERATOR_NOT_FOUND" };

      const pool = await lockPool(tx, operator.poolId);

      const existing = await tx.ledgerEntry.findUnique({ where: key });
      if (existing) return replayOf(existing);

      const now = clock();
      const activeUnits = await getActiveUnits(tx, operator.poolId, now);
      if (!fitsCapacity({ capacity: pool.capacity, activeUnits, units: input.units })) {
        return { ok: false, reason: "CAPACITY_EXCEEDED" };
      }

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
    async () => {
      const existing = await db.ledgerEntry.findUnique({ where: key });
      return existing ? replayOf(existing) : undefined;
    },
    { ok: false, reason: "BUSY" },
  );
}
