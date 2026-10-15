import { adjustBodySchema } from "@/domain/adjustment";
import { adjust } from "../adjust";
import { requireRole, requireUser } from "./auth";
import type { ApiContext } from "./context";
import { failureError, jsonResponse, route } from "./errors";
import { readIdempotencyKey, readJsonBody } from "./request";

/** POST /api/adjustments: the logged-in supervisor adjusts an earlier allocation. */
export const createAdjustment = route(async (request: Request, ctx: ApiContext) => {
  const user = await requireUser(request, ctx.db);
  requireRole(user, "SUPERVISOR");
  const idempotencyKey = readIdempotencyKey(request);
  const body = adjustBodySchema.parse(await readJsonBody(request));

  const result = await adjust(ctx, { supervisorId: user.id, ...body, idempotencyKey });
  if (!result.ok) throw failureError(result.reason);
  return jsonResponse({ replay: result.replay, entry: result.entry }, { status: result.replay ? 200 : 201 });
});
