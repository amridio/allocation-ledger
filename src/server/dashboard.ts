import type { EntriesPageDto, MetricDto, PoolOperatorDto, TimelineDto } from "@/domain/wire";
import type { PrismaClient } from "@/generated/prisma/client";
import type { EntriesScope } from "@/ui/entries-scope";
import { requireAccessibleOperator } from "./api/access";
import type { SessionUser } from "./api/auth";
import { ApiError } from "./api/errors";
import { getEntriesPageDto } from "./queries/entries";
import { getMetricDto } from "./queries/metric";
import { listPoolOperators } from "./queries/operators";
import { getTimelineDto } from "./queries/timeline";

export const PAGE_SIZE = 20;

/** Everything the screen needs on first open, in the same JSON shapes the API returns. */
export interface DashboardData {
  user: SessionUser;
  /** Whose metric and timeline are shown. */
  subject: { id: string; name: string };
  /** The pool's people, for a supervisor's picker; null for an operator. */
  operators: PoolOperatorDto[] | null;
  metric: MetricDto;
  timeline: TimelineDto;
  /**
   * The newest page of the activity log: an operator's own, a supervisor's selected operator (the
   * default), or a supervisor's whole pool (the "everyone" toggle).
   */
  entries: EntriesPageDto;
  entriesScope: EntriesScope;
}

/**
 * Loads the first screen on the server so there is no loading state on first open.
 *
 * The subject (whose numbers are shown) always comes from requireAccessibleOperator(), the same
 * rule the API uses. A requested operator the user may not see is NOT an error here: the screen
 * quietly falls back to the default, so a hand-edited URL can't reveal another site or probe ids.
 */
export async function loadDashboard(
  db: PrismaClient,
  user: SessionUser,
  requestedOperatorId: string | undefined,
  now: Date,
  /** A supervisor's "everyone" toggle: log the whole pool instead of just the selected operator. Ignored for operators. */
  logAll = false,
): Promise<DashboardData> {
  const isSupervisor = user.role === "SUPERVISOR";
  const operators = isSupervisor ? await listPoolOperators(db, user.poolId) : null;

  const defaultId = isSupervisor ? (operators?.find((o) => o.role === "OPERATOR")?.id ?? user.id) : user.id;
  let subject;
  try {
    subject = await requireAccessibleOperator(db, user, isSupervisor ? (requestedOperatorId ?? defaultId) : user.id);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 403) throw err;
    subject = await requireAccessibleOperator(db, user, defaultId);
  }

  const entriesScope: EntriesScope = !isSupervisor ? "self" : logAll ? "pool" : "operator";
  const entriesWhere = entriesScope === "pool" ? { poolId: user.poolId } : { operatorId: entriesScope === "self" ? user.id : subject.id };

  const [metric, timeline, entries] = await Promise.all([
    getMetricDto(db, subject, now),
    getTimelineDto(db, subject, isSupervisor ? "full" : "transitions", now),
    getEntriesPageDto(db, entriesWhere, { limit: PAGE_SIZE }),
  ]);
  return {
    user,
    subject: { id: subject.id, name: subject.name },
    operators,
    metric,
    timeline,
    entries,
    entriesScope,
  };
}
