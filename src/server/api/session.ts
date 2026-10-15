import { z } from "zod";
import { sessionCookie } from "./auth";
import type { ApiContext } from "./context";
import { jsonResponse, notFound, route } from "./errors";
import { readJsonBody } from "./request";

const switchUserSchema = z.object({ userId: z.string().min(1) }).strict();

/**
 * POST /api/switch-user { userId }: TEMPORARY, and 404 unless ENABLE_USER_SWITCHER=true.
 * Sets the session cookie to any existing user.
 * This is how you "log in" until real login exists; it provides no security (see auth.ts).
 */
export const switchUser = route(async (request: Request, ctx: ApiContext) => {
  // Off unless ENABLE_USER_SWITCHER=true: with it off the endpoint does not exist, not just the button.
  if (!ctx.userSwitcherEnabled) throw notFound("Not found.");
  const { userId } = switchUserSchema.parse(await readJsonBody(request));
  const user = await ctx.db.operator.findUnique({ where: { id: userId } });
  if (!user) throw notFound("No such user.");
  return jsonResponse(
    { user: { id: user.id, name: user.name, role: user.role, poolId: user.poolId } },
    { headers: { "Set-Cookie": sessionCookie(user.id) } },
  );
});
