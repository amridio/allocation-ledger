import { operatorMetric } from "@/domain/metric";
import { metricQuerySchema } from "@/domain/queries";
import { getActiveUnits } from "../ledger-tx";
import { loadOperatorEntries } from "../ledger-read";
import { requireUser } from "./auth";
import type { ApiContext } from "./context";
import { forbidden, jsonResponse, notFound, route } from "./errors";
import { readQuery } from "./request";

/**
 * GET /api/metric[?operatorId=]
 * The operator's active units and status right now, plus their pool's capacity, active units and
 * lifetime balance (the cached sum of every ledger row, expired or not). A supervisor may look at
 * any operator; an operator only at themselves.
 */
export const getMetric = route(async (request: Request, ctx: ApiContext) => {
  const user = await requireUser(request, ctx.db);
  const query = readQuery(request, metricQuerySchema);

  if (user.role === "OPERATOR" && query.operatorId !== undefined && query.operatorId !== user.id) {
    throw forbidden("Operators can only see their own metric.");
  }
  const subject = await ctx.db.operator.findUnique({ where: { id: query.operatorId ?? user.id } });
  if (!subject) throw notFound("Operator not found.");

  const now = ctx.clock();
  const metric = operatorMetric(await loadOperatorEntries(ctx.db, subject.id), now);
  const pool = await ctx.db.pool.findUniqueOrThrow({ where: { id: subject.poolId } });

  return jsonResponse({
    asOf: now,
    operator: { id: subject.id, name: subject.name, ...metric },
    pool: {
      id: pool.id,
      name: pool.name,
      capacity: pool.capacity,
      activeUnits: await getActiveUnits(ctx.db, pool.id, now),
      lifetimeBalance: pool.balance,
    },
  });
});
