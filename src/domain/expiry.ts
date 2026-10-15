/**
 * When an allocation stops counting toward active units.
 *
 * Calculated ONCE, at creation, from the operator's tier at that time, then stored
 * on the ledger row (never recomputed). null expiryMinutes = never expires.
 *
 * Base time is `effectiveAt` (when the allocation happened in the field), not when
 * the server recorded it: a late sync from a phone shouldn't extend the allocation's life.
 * TO CONFIRM WITH CLIENT.
 */
export function computeExpiresAt(effectiveAt: Date, expiryMinutes: number | null): Date | null {
  if (expiryMinutes === null) return null;
  return new Date(effectiveAt.getTime() + expiryMinutes * 60_000);
}
