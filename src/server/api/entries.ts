import { allocateBodySchema } from "@/domain/allocation";
import { entriesQuerySchema } from "@/domain/queries";
import type { Prisma } from "@/generated/prisma/client";
import { allocate } from "../allocate";
import { requireRole, requireUser } from "./auth";
import type { ApiContext } from "./context";
import { failureError, forbidden, jsonResponse, notFound, route } from "./errors";
import { readIdempotencyKey, readJsonBody, readQuery } from "./request";

/** POST /api/entries: the logged-in operator logs an allocation for themselves. */
export const createEntry = route(async (request: Request, ctx: ApiContext) => {
  const user = await requireUser(request, ctx.db);
  requireRole(user, "OPERATOR");
  const idempotencyKey = readIdempotencyKey(request);
  const { units } = allocateBodySchema.parse(await readJsonBody(request));

  const result = await allocate(ctx, { operatorId: user.id, units, idempotencyKey });
  if (!result.ok) throw failureError(result.reason);
  return jsonResponse({ replay: result.replay, entry: result.entry }, { status: result.replay ? 200 : 201 });
});

/**
 * GET /api/entries?cursor=&limit=&operatorId=
 * Newest first, paged by seq. An operator sees their own entries; a supervisor sees their whole
 * pool, or one operator's with ?operatorId=.
 */
export const listEntries = route(async (request: Request, ctx: ApiContext) => {
  const user = await requireUser(request, ctx.db);
  const query = readQuery(request, entriesQuerySchema);

  let scope: Prisma.LedgerEntryWhereInput;
  if (user.role === "OPERATOR") {
    if (query.operatorId !== undefined && query.operatorId !== user.id) {
      throw forbidden("Operators can only see their own entries.");
    }
    scope = { operatorId: user.id };
  } else if (query.operatorId !== undefined) {
    const operator = await ctx.db.operator.findUnique({ where: { id: query.operatorId } });
    if (!operator) throw notFound("Operator not found.");
    scope = { operatorId: operator.id };
  } else {
    scope = { poolId: user.poolId };
  }

  // One extra row tells us whether another page exists without a second count query.
  const rows = await ctx.db.ledgerEntry.findMany({
    where: { ...scope, ...(query.cursor === undefined ? {} : { seq: { lt: query.cursor } }) },
    orderBy: { seq: "desc" },
    take: query.limit + 1,
  });
  const hasMore = rows.length > query.limit;
  const entries = hasMore ? rows.slice(0, query.limit) : rows;
  return jsonResponse({ entries, nextCursor: hasMore ? (entries.at(-1)?.seq ?? null) : null });
});
