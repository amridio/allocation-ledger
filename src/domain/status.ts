import { STATUS_CUTOFFS, type StatusLevel } from "./status-config";

/** Status level for a balance of ACTIVE (non-expired) units. Cutoffs live in status-config.ts. */
export function deriveStatus(balance: number): StatusLevel {
  if (balance >= STATUS_CUTOFFS.HIGH) return "HIGH";
  if (balance >= STATUS_CUTOFFS.NORMAL) return "NORMAL";
  if (balance >= STATUS_CUTOFFS.LOW) return "LOW";
  return "CRITICAL";
}
