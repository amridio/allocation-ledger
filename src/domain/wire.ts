import type { StatusLevel } from "./status-config";

/*
 * The JSON the API sends, exactly: dates are ISO strings. The server-rendered page builds the
 * SAME shapes, so the data it hands to the browser is identical to what a later fetch returns.
 */

export interface TimelinePointDto {
  at: string;
  balance: number;
  status: StatusLevel;
}

export interface EntryDto {
  seq: number;
  kind: "ALLOCATION" | "ADJUSTMENT";
  operatorId: string;
  poolId: string;
  createdById: string;
  units: number;
  effectiveAt: string;
  recordedAt: string;
  expiresAt: string | null;
  refSeq: number | null;
  reason: string | null;
  idempotencyKey: string;
}

export interface EntriesPageDto {
  entries: EntryDto[];
  /** Pass back as `cursor` for the next (older) page; null = last page. */
  nextCursor: number | null;
}

export interface MetricDto {
  asOf: string;
  operator: { id: string; name: string; activeUnits: number; status: StatusLevel };
  /** When the operator's active units next drop because an entry expires; null if none will. */
  nextExpiryAt: string | null;
  pool: { id: string; name: string; capacity: number | null; activeUnits: number; lifetimeBalance: number };
}

export interface TimelineDto {
  operatorId: string;
  view: "transitions" | "full";
  asOf: string;
  points: TimelinePointDto[];
}

export interface PoolOperatorDto {
  id: string;
  name: string;
  role: "OPERATOR" | "SUPERVISOR";
}
