import { deriveStatus } from "./status";
import type { StatusLevel } from "./status-config";

/**
 * The part of a ledger row the domain needs. Structural on purpose: no Prisma types here.
 * An ADJUSTMENT is just a signed entry; it takes effect at its own `effectiveAt`.
 */
export interface DomainEntry {
  seq: number;
  kind: "ALLOCATION" | "ADJUSTMENT";
  /** Signed. */
  units: number;
  effectiveAt: Date;
  /** null = never expires. For adjustments, the same value as the entry they adjust. */
  expiresAt: Date | null;
  refSeq?: number | null;
}

export interface StatusPoint {
  /** The instant the balance changed. */
  at: Date;
  /** Active units from this instant until the next point. */
  balance: number;
  status: StatusLevel;
}

/**
 * THE BOUNDARY RULE: an entry is active from `effectiveAt` UP TO, BUT NOT INCLUDING,
 * `expiresAt` (the half-open interval [effectiveAt, expiresAt)).
 *
 *   - AT effectiveAt it already counts.
 *   - AT expiresAt it is already gone ("expired at the exact time").
 *
 * Why half-open: when one entry expires at the same instant its replacement takes
 * effect, exactly one of them counts at that instant. A closed interval would count
 * both for that instant (double count); an interval open at both ends would count
 * neither (a gap).
 *
 * An entry with expiresAt <= effectiveAt is never active.
 * Mirrored in SQL by the schema's `expires_at IS NULL OR expires_at > now` capacity check.
 */
function isActiveAt(entry: DomainEntry, atMs: number): boolean {
  return (
    entry.effectiveAt.getTime() <= atMs && (entry.expiresAt === null || entry.expiresAt.getTime() > atMs)
  );
}

/**
 * Sum of units that count at instant `at`. `at` is always passed in: this function
 * never reads the clock. Not clamped, so it can be negative.
 */
export function activeBalance(entries: readonly DomainEntry[], at: Date): number {
  const atMs = at.getTime();
  let balance = 0;
  for (const entry of entries) {
    if (isActiveAt(entry, atMs)) balance += entry.units;
  }
  return balance;
}

/**
 * Balance and status over time: one point per instant at which the active balance changes
 * (an entry takes effect or expires), in ascending order.
 *
 * - Events at the same instant are merged into one point.
 * - An instant whose events cancel out produces no point.
 * - Derived purely from the entries, so a backdated adjustment changes every point from
 *   its effectiveAt onward and leaves earlier points untouched.
 * - Covers all time, including entries that are still in the future. Callers that only
 *   want "up to now" filter the result.
 */
export function statusTimeline(entries: readonly DomainEntry[]): StatusPoint[] {
  const deltaAt = new Map<number, number>();
  const addDelta = (ms: number, delta: number) => deltaAt.set(ms, (deltaAt.get(ms) ?? 0) + delta);

  for (const entry of entries) {
    const start = entry.effectiveAt.getTime();
    if (entry.expiresAt !== null && entry.expiresAt.getTime() <= start) continue; // never active
    addDelta(start, entry.units);
    if (entry.expiresAt !== null) addDelta(entry.expiresAt.getTime(), -entry.units);
  }

  const points: StatusPoint[] = [];
  let balance = 0;
  for (const [ms, delta] of [...deltaAt].sort((a, b) => a[0] - b[0])) {
    if (delta === 0) continue;
    balance += delta;
    points.push({ at: new Date(ms), balance, status: deriveStatus(balance) });
  }
  return points;
}

/**
 * The operator-facing view: only the points where the STATUS changes.
 *
 * Built from statusTimeline, so every point returned is one of its points, unchanged.
 * The first point is always kept (it is the start of the history), and after that a point
 * is kept only if its status differs from the previous point's. Consequently no two
 * consecutive points share a status, and at any moment the status is that of the latest
 * transition at or before it. Supervisors use statusTimeline for every balance change.
 */
export function statusTransitions(entries: readonly DomainEntry[]): StatusPoint[] {
  const transitions: StatusPoint[] = [];
  for (const point of statusTimeline(entries)) {
    const previous = transitions[transitions.length - 1];
    if (previous === undefined || previous.status !== point.status) transitions.push(point);
  }
  return transitions;
}
