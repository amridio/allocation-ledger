/** A ledger row as the service returns it (structural, so tests and handlers don't need Prisma). */
export interface AllocationEntry {
  seq: number;
  kind: "ALLOCATION" | "ADJUSTMENT";
  operatorId: string;
  poolId: string;
  createdById: string;
  units: number;
  effectiveAt: Date;
  recordedAt: Date;
  expiresAt: Date | null;
  refSeq: number | null;
  reason: string | null;
  idempotencyKey: string;
}

export type AllocateFailure =
  /** Same idempotency key, different payload. HTTP 409. */
  | "IDEMPOTENCY_KEY_REUSED"
  /** The pool's active units + this allocation would exceed its capacity. HTTP 422. */
  | "CAPACITY_EXCEEDED"
  | "OPERATOR_NOT_FOUND"
  /** Lock or transaction timeout. Nothing was written; safe to retry with the same key. HTTP 503. */
  | "BUSY";

export type AllocateResult =
  | { ok: true; replay: boolean; entry: AllocationEntry }
  | { ok: false; reason: AllocateFailure };
