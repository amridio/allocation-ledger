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

/**
 * The next instant after `now` at which this operator's active units drop because an entry
 * expires, or null if nothing active will ever expire. Only entries that are active now count
 * (an entry that already expired, or hasn't taken effect, can't be "next"). At exactly `now` an
 * expiring entry is already gone (boundary rule in ledger.ts), so it isn't returned.
 *
 * The client schedules a refetch for this moment, so the number and status change the instant
 * the entry expires instead of at the next poll.
 */
export function nextExpiryAt(entries: readonly DomainEntry[], now: Date): Date | null {
  const nowMs = now.getTime();
  let earliest: number | null = null;
  for (const entry of entries) {
    if (entry.expiresAt === null) continue;
    const expiresMs = entry.expiresAt.getTime();
    const active = entry.effectiveAt.getTime() <= nowMs && expiresMs > nowMs;
    if (active && (earliest === null || expiresMs < earliest)) earliest = expiresMs;
  }
  return earliest === null ? null : new Date(earliest);
}

/**
 * The metric the screen shows while allocations are still being sent: the server's active units
 * plus the pending units, with the status re-derived from the total using the same cutoffs as
 * the server. The server's answer always replaces this once it arrives.
 */
export function applyPendingUnits(
  base: { activeUnits: number; status: StatusLevel },
  pendingUnits: readonly number[],
): { activeUnits: number; status: StatusLevel } {
  const activeUnits = pendingUnits.reduce((sum, units) => sum + units, base.activeUnits);
  return { activeUnits, status: deriveStatus(activeUnits) };
}
