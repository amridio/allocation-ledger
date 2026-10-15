import { metricQuerySchema } from "@/domain/queries";
import { getMetricDto } from "../queries/metric";
import { requireAccessibleOperator } from "./access";
import { requireUser } from "./auth";
import type { ApiContext } from "./context";
import { jsonResponse, route } from "./errors";
import { readQuery } from "./request";

/**
 * GET /api/metric[?operatorId=]
 * The operator's active units and status right now, plus their pool's capacity, active units and
 * lifetime balance (the cached sum of every ledger row, expired or not). A supervisor may look at
 * operators in their own pool; an operator only at themselves; anything else is 403 (see access.ts).
 */
export const getMetric = route(async (request: Request, ctx: ApiContext) => {
  const user = await requireUser(request, ctx.db);
  const query = readQuery(request, metricQuerySchema);

  const subject = await requireAccessibleOperator(ctx.db, user, query.operatorId ?? user.id);

  return jsonResponse(await getMetricDto(ctx.db, subject, ctx.clock()));
});
