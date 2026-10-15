/**
 * Status cutoffs, measured in ACTIVE (non-expired) units.
 *
 * DEFAULTS: TO CONFIRM WITH CLIENT. This is the only place the numbers live;
 * components and handlers must derive status via `deriveStatus`.
 *
 * Each value is the inclusive lower bound of that level. Anything below
 * LOW's bound (including negative totals) is CRITICAL.
 *   CRITICAL: below 20
 *   LOW:      20 to 49
 *   NORMAL:   50 to 99
 *   HIGH:     100 and above
 */
export const STATUS_LEVELS = ["CRITICAL", "LOW", "NORMAL", "HIGH"] as const;
export type StatusLevel = (typeof STATUS_LEVELS)[number];

export const STATUS_CUTOFFS = {
  LOW: 20,
  NORMAL: 50,
  HIGH: 100,
} as const satisfies Record<Exclude<StatusLevel, "CRITICAL">, number>;
