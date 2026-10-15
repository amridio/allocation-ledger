import { statusTimeline, statusTransitions } from "@/domain/ledger";
import { timelineQuerySchema } from "@/domain/queries";
import { loadOperatorEntries } from "../ledger-read";
import { requireAccessibleOperator } from "./access";
import { requireUser } from "./auth";
import type { ApiContext } from "./context";
import { forbidden, jsonResponse, route } from "./errors";
import { readQuery } from "./request";

/**
 * GET /api/operators/:operatorId/timeline[?view=transitions|full]
 * transitions = only the points where the status changes (the operator view, and the default for
 * operators). full = every balance change (supervisors, and their default). Operators see only
 * themselves and supervisors only operators in their own pool; anything else is 403 (see access.ts). Covers all time,
 * including entries that haven't taken effect yet, so clients filter to `asOf` if they want "so far".
 */
export const getTimeline = route(async (request: Request, ctx: ApiContext, operatorId: string) => {
  const user = await requireUser(request, ctx.db);
  const query = readQuery(request, timelineQuerySchema);

  const operator = await requireAccessibleOperator(ctx.db, user, operatorId);
  if (user.role === "OPERATOR" && query.view === "full") throw forbidden("The full timeline is for supervisors.");

  const view = query.view ?? (user.role === "SUPERVISOR" ? "full" : "transitions");
  const entries = await loadOperatorEntries(ctx.db, operator.id);
  const points = view === "full" ? statusTimeline(entries) : statusTransitions(entries);
  return jsonResponse({ operatorId: operator.id, view, asOf: ctx.clock(), points });
});
