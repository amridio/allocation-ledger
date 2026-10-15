import { z } from "zod";

/** Query-string contracts for the GET endpoints. Strict, so a typo'd parameter is an error, not silently ignored. */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * GET /api/entries. Newest first, paged by `seq`: `cursor` is the seq of the last entry you
 * already have, and the next page is everything with a smaller seq.
 */
export const entriesQuerySchema = z
  .object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    /** Supervisors only: restrict to one operator. */
    operatorId: z.string().min(1).optional(),
  })
  .strict();

/** GET /api/metric. A supervisor may ask about another operator. */
export const metricQuerySchema = z.object({ operatorId: z.string().min(1).optional() }).strict();

export const TIMELINE_VIEWS = ["transitions", "full"] as const;
/**
 * GET /api/operators/:id/timeline. `transitions` = only the points where the status changes
 * (the operator view); `full` = every balance change (supervisors).
 */
export const timelineQuerySchema = z.object({ view: z.enum(TIMELINE_VIEWS).optional() }).strict();
export type TimelineView = (typeof TIMELINE_VIEWS)[number];
