import { z } from "zod";

/**
 * Request to log an allocation. Strict on purpose: `effectiveAt` and `expiresAt` are set by
 * the server, so a client can't backdate an allocation or choose its own expiry.
 */
export const allocateInputSchema = z
  .object({
    operatorId: z.string().min(1),
    units: z.number().int().positive(),
    /** Client-generated; unique per operator. Resend the same key to retry safely. */
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export type AllocateInput = z.infer<typeof allocateInputSchema>;

/** The fields that define "the same request" for an idempotent retry. */
export interface IdempotencyPayload {
  operatorId: string;
  kind: "ALLOCATION" | "ADJUSTMENT";
  units: number;
  refSeq: number | null;
}

/**
 * Is `requested` a genuine retry of the request that created `existing`?
 *
 * Compares operator, kind, units and refSeq (refSeq matters for adjustments) and nothing
 * else. In particular NOT effectiveAt: for allocations the server sets it, so a real retry
 * always arrives with a different one and would be wrongly rejected.
 */
export function isSamePayload(existing: IdempotencyPayload, requested: IdempotencyPayload): boolean {
  return (
    existing.operatorId === requested.operatorId &&
    existing.kind === requested.kind &&
    existing.units === requested.units &&
    existing.refSeq === requested.refSeq
  );
}

/**
 * Does `units` more fit in the pool? `activeUnits` is the pool's ACTIVE (non-expired) units,
 * not the cached balance. capacity null = no limit. Exactly reaching capacity fits.
 */
export function fitsCapacity(params: { capacity: number | null; activeUnits: number; units: number }): boolean {
  if (params.capacity === null) return true;
  return params.activeUnits + params.units <= params.capacity;
}
