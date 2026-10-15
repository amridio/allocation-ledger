import { activeBalance, type DomainEntry } from "./ledger";
import { deriveStatus } from "./status";
import type { StatusLevel } from "./status-config";

/** An operator's headline numbers right now: active (non-expired, already effective) units and the status they give. */
export function operatorMetric(
  entries: readonly DomainEntry[],
  now: Date,
): { activeUnits: number; status: StatusLevel } {
  const activeUnits = activeBalance(entries, now);
  return { activeUnits, status: deriveStatus(activeUnits) };
}
