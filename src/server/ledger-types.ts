/** A ledger row as the service returns it (structural, so tests and handlers don't need Prisma). */
export interface LedgerEntryRecord {
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
  | { ok: true; replay: boolean; entry: LedgerEntryRecord }
  | { ok: false; reason: AllocateFailure };

export type AdjustFailure =
  | "IDEMPOTENCY_KEY_REUSED"
  | "CAPACITY_EXCEEDED"
  | "SUPERVISOR_NOT_FOUND"
  /** The acting user exists but is not a supervisor. HTTP 403. */
  | "NOT_SUPERVISOR"
  | "TARGET_NOT_FOUND"
  /** Only ALLOCATIONs can be adjusted (adjust the original instead of an adjustment). HTTP 422. */
  | "TARGET_NOT_ALLOCATION"
  /** The target belongs to another pool (site). A supervisor may only adjust their own pool. HTTP 403. */
  | "TARGET_OTHER_POOL"
  /** The entry's net units (original + all adjustments + this one) would go below zero. HTTP 422. */
  | "ADJUSTMENT_BELOW_ZERO"
  | "BUSY";

export type AdjustResult =
  | { ok: true; replay: boolean; entry: LedgerEntryRecord }
  | { ok: false; reason: AdjustFailure };
