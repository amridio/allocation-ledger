import type { PrismaClient } from "@/generated/prisma/client";
import type { SessionUser } from "./auth";
import { forbidden } from "./errors";

export interface AccessibleOperator {
  id: string;
  name: string;
  poolId: string;
}

/**
 * THE read-access rule, for every endpoint that shows an operator's data:
 *
 *   operator   -> only themselves
 *   supervisor -> any operator in their OWN pool (themselves included)
 *   anything else -> 403
 *
 * "Anything else" deliberately includes an id that doesn't exist, with the same error as an
 * operator in another pool, so nobody can use 403-versus-404 to find out which ids exist at
 * other sites. An operator's own id is never looked up in the database, and any other id is
 * refused before a lookup, for the same reason.
 *
 * Endpoints must obtain their subject operator through this function (and nothing else) so the rule
 * can't be forgotten: access-coverage.test.ts fails for any route that doesn't. The write-side
 * equivalent (a supervisor adjusting only their own pool's entries) lives in adjust().
 */
export async function requireAccessibleOperator(
  db: PrismaClient,
  user: SessionUser,
  operatorId: string,
): Promise<AccessibleOperator> {
  if (user.role === "OPERATOR") {
    if (operatorId !== user.id) throw denied();
    return { id: user.id, name: user.name, poolId: user.poolId };
  }
  const operator = await db.operator.findUnique({
    where: { id: operatorId },
    select: { id: true, name: true, poolId: true },
  });
  if (!operator || operator.poolId !== user.poolId) throw denied();
  return operator;
}

const denied = () => forbidden("You can't view that operator.");
