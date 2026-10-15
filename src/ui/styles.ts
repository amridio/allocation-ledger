/*
 * Shared class strings. Hard requirements are written as explicit pixel values on purpose:
 * the root font size is 18px, so rem-based sizes (min-h-12 etc.) would silently drift.
 *   buttons and inputs: at least 56px tall (48px is the floor)
 *   gaps between touch targets: at least 12px
 */
const BUTTON =
  "inline-flex min-h-[56px] items-center justify-center gap-3 rounded-xl border-4 px-6 text-xl font-bold " +
  "disabled:border-ink-soft disabled:bg-pending-bg disabled:text-ink-soft";

export const BTN_PRIMARY = `${BUTTON} border-ink bg-action text-action-text`;
export const BTN_SECONDARY = `${BUTTON} border-ink bg-page text-ink`;
export const BTN_DANGER = `${BUTTON} border-danger bg-danger-bg text-danger`;

export const INPUT = "min-h-[56px] w-full rounded-xl border-4 border-ink bg-page px-4 text-2xl font-bold text-ink";
export const LABEL = "mb-2 block text-xl font-bold text-ink";
export const CARD = "rounded-2xl border-4 border-border bg-page p-5";
export const HEADING = "text-2xl font-extrabold text-ink";
