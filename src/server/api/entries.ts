import { allocateBodySchema } from "@/domain/allocation";
import { entriesQuerySchema } from "@/domain/queries";
import { allocate } from "../allocate";
import { getEntriesPageDto, type EntriesScope } from "../queries/entries";
import { requireAccessibleOperator } from "./access";
import { requireRole, requireUser } from "./auth";
import type { ApiContext } from "./context";
import { failureError, jsonResponse, route } from "./errors";
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
 * Newest first, paged by seq. An operator sees their own entries; a supervisor sees their own pool,
 * or one operator's in it with ?operatorId=. Anything outside that is 403 (see access.ts).
 */
export const listEntries = route(async (request: Request, ctx: ApiContext) => {
  const user = await requireUser(request, ctx.db);
  const query = readQuery(request, entriesQuerySchema);

  // With ?operatorId= the subject must pass the shared read rule. Without it: an operator sees their
  // own entries, a supervisor their whole pool (every entry in a pool belongs to an operator in it).
  let scope: EntriesScope;
  if (query.operatorId !== undefined) {
    const subject = await requireAccessibleOperator(ctx.db, user, query.operatorId);
    scope = { operatorId: subject.id };
  } else {
    scope = user.role === "OPERATOR" ? { operatorId: user.id } : { poolId: user.poolId };
  }

  return jsonResponse(await getEntriesPageDto(ctx.db, scope, { cursor: query.cursor, limit: query.limit }));
});
