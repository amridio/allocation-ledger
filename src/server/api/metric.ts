import { operatorMetric } from "@/domain/metric";
import { metricQuerySchema } from "@/domain/queries";
import { getActiveUnits } from "../ledger-tx";
import { loadOperatorEntries } from "../ledger-read";
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
