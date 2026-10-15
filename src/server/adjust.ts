import { addedActiveUnits, buildAdjustment, type AdjustInput } from "@/domain/adjustment";
import { fitsCapacity, isSamePayload } from "@/domain/allocation";
import type { AdjustResult, LedgerEntryRecord } from "./ledger-types";
import { getActiveUnits, lockPool, runLedgerTransaction, type LedgerTxDeps } from "./ledger-tx";

export type AdjustDeps = LedgerTxDeps;

/**
 * Supervisor adjustment of an earlier ALLOCATION. Same pattern as allocate(): one transaction,
 * lock the pool row, idempotency lookup AFTER the lock and BEFORE the capacity check, capacity
 * check, insert + atomic balance increment, unique index as the backstop.
 *
 *   - Only a SUPERVISOR may adjust (NOT_SUPERVISOR otherwise).
 *   - The target must be an ALLOCATION (adjust the original, not an adjustment).
 *   - The adjustment copies the target's effectiveAt and expiresAt (see buildAdjustment).
 *   - The pool that is locked and changed is the TARGET's, not the supervisor's.
 *   - Capacity is only checked for units that would be active now (addedActiveUnits): a negative
 *     adjustment, or one on an already-expired target, can't push the pool over capacity.
 *
 * The unique index is per creator, not per pool, so the same supervisor and key arriving for
 * targets in two pools are NOT serialized by the pool lock. The backstop catches that case.
 */
export async function adjust(deps: AdjustDeps, input: AdjustInput): Promise<AdjustResult> {
  const { db, clock } = deps;
  const key = {
    createdById_idempotencyKey: { createdById: input.supervisorId, idempotencyKey: input.idempotencyKey },
  };

  const replayOf = (existing: LedgerEntryRecord, target: { operatorId: string; seq: number }): AdjustResult =>
    isSamePayload(existing, { operatorId: target.operatorId, kind: "ADJUSTMENT", units: input.units, refSeq: target.seq })
      ? { ok: true, replay: true, entry: existing }
      : { ok: false, reason: "IDEMPOTENCY_KEY_REUSED" };

  return runLedgerTransaction<AdjustResult>(
    deps,
    async (tx) => {
      const supervisor = await tx.operator.findUnique({ where: { id: input.supervisorId } });
      if (!supervisor) return { ok: false, reason: "SUPERVISOR_NOT_FOUND" };
      if (supervisor.role !== "SUPERVISOR") return { ok: false, reason: "NOT_SUPERVISOR" };

      // The ledger is append-only, so the target can't change between this read and the lock.
      const target = await tx.ledgerEntry.findUnique({ where: { seq: input.targetSeq } });
      if (!target) return { ok: false, reason: "TARGET_NOT_FOUND" };
      if (target.kind !== "ALLOCATION") return { ok: false, reason: "TARGET_NOT_ALLOCATION" };

      const pool = await lockPool(tx, target.poolId);

      const existing = await tx.ledgerEntry.findUnique({ where: key });
      if (existing) return replayOf(existing, target);

      const now = clock();
      const adjustment = buildAdjustment(target, input);
      const added = addedActiveUnits(adjustment, now);
      if (added > 0) {
        const activeUnits = await getActiveUnits(tx, target.poolId, now);
        if (!fitsCapacity({ capacity: pool.capacity, activeUnits, units: added })) {
          return { ok: false, reason: "CAPACITY_EXCEEDED" };
        }
      }

      const entry = await tx.ledgerEntry.create({ data: adjustment });
      await tx.pool.update({ where: { id: target.poolId }, data: { balance: { increment: adjustment.units } } });
      return { ok: true, replay: false, entry };
    },
    async () => {
      const existing = await db.ledgerEntry.findUnique({ where: key });
      const target = existing && (await db.ledgerEntry.findUnique({ where: { seq: input.targetSeq } }));
      return existing && target ? replayOf(existing, target) : undefined;
    },
    { ok: false, reason: "BUSY" },
  );
}
