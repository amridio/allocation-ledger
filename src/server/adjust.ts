import { addedActiveUnits, buildAdjustment, wouldOverCorrect, type AdjustInput } from "@/domain/adjustment";
import { fitsCapacity, isSamePayload } from "@/domain/allocation";
import type { AdjustResult, LedgerEntryRecord } from "./ledger-types";
import { getActiveUnits, lockPool, runLedgerTransaction, type LedgerTxDeps } from "./ledger-tx";

export type AdjustDeps = LedgerTxDeps;

/**
 * Supervisor adjustment of an earlier ALLOCATION. Same pattern as allocate(): one transaction,
 * lock the pool row, idempotency lookup AFTER the lock and BEFORE the capacity check, capacity
 * check, insert + atomic balance increment, unique index as the backstop.
 *
 *   - Only a SUPERVISOR may adjust (NOT_SUPERVISOR otherwise), and only entries in their OWN
 *     pool (TARGET_OTHER_POOL): a supervisor at one site can't change another site's numbers.
 *   - The target must be an ALLOCATION (adjust the original, not an adjustment).
 *   - The adjustment copies the target's effectiveAt and expiresAt (see buildAdjustment).
 *   - An entry's net units (original + all its adjustments + this one) can't go below zero
 *     (ADJUSTMENT_BELOW_ZERO), checked under the pool lock.
 *   - Capacity is only checked for units that would be active now (addedActiveUnits): a negative
 *     adjustment, or one on an already-expired target, can't push the pool over capacity.
 *
 * Because a supervisor only acts in their own pool, one creator + idempotency key always lands in
 * one pool and the pool lock serializes it. The unique-index backstop only matters for writers that
 * bypass this service.
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
      // A supervisor can only touch their own site. Checked before anything else about the target
      // so a supervisor can't learn what kind of entry it is, and before taking any lock.
      if (target.poolId !== supervisor.poolId) return { ok: false, reason: "TARGET_OTHER_POOL" };
      if (target.kind !== "ALLOCATION") return { ok: false, reason: "TARGET_NOT_ALLOCATION" };

      const pool = await lockPool(tx, target.poolId);

      const existing = await tx.ledgerEntry.findUnique({ where: key });
      if (existing) return replayOf(existing, target);

      // Over-correction: the entry's net units must stay >= 0. This reads the earlier adjustments
      // AFTER the pool lock, and every adjustment to this entry lives in (and is written under the
      // lock of) this same pool, so two supervisors adjusting the same entry can't both pass.
      const prior = await tx.ledgerEntry.aggregate({ where: { refSeq: target.seq }, _sum: { units: true } });
      if (wouldOverCorrect({ targetUnits: target.units, priorAdjustmentsTotal: prior._sum.units ?? 0, delta: input.units })) {
        return { ok: false, reason: "ADJUSTMENT_BELOW_ZERO" };
      }

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
