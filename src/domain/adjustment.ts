import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency";
import { activeBalance } from "./ledger";

/**
 * Service-level input for a supervisor adjustment. Strict on purpose: effectiveAt, expiresAt and
 * the operator all come from the target entry, never from the caller.
 */
export const adjustInputSchema = z
  .object({
    supervisorId: z.string().min(1),
    /** The seq of the ALLOCATION being adjusted. */
    targetSeq: z.number().int().positive(),
    /** Signed, never 0: positive adds units, negative removes them. */
    units: z.number().int().refine((n) => n !== 0, "units must not be 0"),
    /** Required: every adjustment must say why. */
    reason: z.string().trim().min(1).max(500),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export type AdjustInput = z.infer<typeof adjustInputSchema>;

/**
 * The HTTP body of POST /api/adjustments. The supervisor is the logged-in user (cookie) and the
 * idempotency key is the `Idempotency-Key` header, so neither may appear in the body.
 */
export const adjustBodySchema = adjustInputSchema.pick({ targetSeq: true, units: true, reason: true }).strict();

/** The part of the target entry an adjustment copies from. */
export interface AdjustmentTarget {
  seq: number;
  kind: "ALLOCATION" | "ADJUSTMENT";
  operatorId: string;
  poolId: string;
  effectiveAt: Date;
  expiresAt: Date | null;
}

export interface NewAdjustment {
  kind: "ADJUSTMENT";
  operatorId: string;
  poolId: string;
  createdById: string;
  units: number;
  effectiveAt: Date;
  expiresAt: Date | null;
  refSeq: number;
  reason: string;
  idempotencyKey: string;
}

/**
 * The row to insert for an adjustment. It is dated at the TARGET's effectiveAt (so it changes
 * the balance and status from the moment of the entry it corrects, never before) and expires
 * together with the target (so the two drop out of the active balance at the same instant).
 */
export function buildAdjustment(target: AdjustmentTarget, input: AdjustInput): NewAdjustment {
  return {
    kind: "ADJUSTMENT",
    operatorId: target.operatorId,
    poolId: target.poolId,
    createdById: input.supervisorId,
    units: input.units,
    effectiveAt: new Date(target.effectiveAt.getTime()),
    expiresAt: target.expiresAt === null ? null : new Date(target.expiresAt.getTime()),
    refSeq: target.seq,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  };
}

/**
 * How many ACTIVE units this adjustment would add at `now`, for the capacity check.
 * Uses the same boundary rule as activeBalance: an adjustment on an already-expired target
 * adds nothing, and a negative adjustment never adds usage.
 */
export function addedActiveUnits(
  adjustment: { units: number; effectiveAt: Date; expiresAt: Date | null },
  now: Date,
): number {
  const asEntry = { seq: 0, kind: "ADJUSTMENT", refSeq: null, ...adjustment } as const;
  return Math.max(0, activeBalance([asEntry], now));
}
