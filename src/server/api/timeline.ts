import { statusTimeline, statusTransitions } from "@/domain/ledger";
import { timelineQuerySchema } from "@/domain/queries";
import { loadOperatorEntries } from "../ledger-read";
import { requireUser } from "./auth";
import type { ApiContext } from "./context";
import { forbidden, jsonResponse, notFound, route } from "./errors";
import { readQuery } from "./request";

/**
 * GET /api/operators/:operatorId/timeline[?view=transitions|full]
 * transitions = only the points where the status changes (the operator view, and the default for
 * operators). full = every balance change (supervisors, and their default). Covers all time,
 * including entries that haven't taken effect yet, so clients filter to `asOf` if they want "so far".
 */
export const getTimeline = route(async (request: Request, ctx: ApiContext, operatorId: string) => {
  const user = await requireUser(request, ctx.db);
  const query = readQuery(request, timelineQuerySchema);

  // Operators are checked BEFORE the lookup, so they can't use 403-vs-404 to probe which ids exist.
  if (user.role === "OPERATOR") {
    if (operatorId !== user.id) throw forbidden("Operators can only see their own timeline.");
    if (query.view === "full") throw forbidden("The full timeline is for supervisors.");
  }
  const operator = await ctx.db.operator.findUnique({ where: { id: operatorId } });
  if (!operator) throw notFound("Operator not found.");

  const view = query.view ?? (user.role === "SUPERVISOR" ? "full" : "transitions");
  const entries = await loadOperatorEntries(ctx.db, operator.id);
  const points = view === "full" ? statusTimeline(entries) : statusTransitions(entries);
  return jsonResponse({ operatorId: operator.id, view, asOf: ctx.clock(), points });
});
