import type { PoolOperatorDto } from "@/domain/wire";
import type { PrismaClient } from "@/generated/prisma/client";

/** Everyone in a pool, for a supervisor's operator picker. Only ever called with the supervisor's OWN pool id. */
export async function listPoolOperators(db: PrismaClient, poolId: string): Promise<PoolOperatorDto[]> {
  return db.operator.findMany({
    where: { poolId },
    select: { id: true, name: true, role: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
}

/** Every user in the system, for the TEMPORARY user switcher only (ENABLE_USER_SWITCHER=true). */
export async function listAllUsersForSwitcher(
  db: PrismaClient,
): Promise<{ id: string; name: string; role: "OPERATOR" | "SUPERVISOR"; poolName: string }[]> {
  const rows = await db.operator.findMany({
    select: { id: true, name: true, role: true, pool: { select: { name: true } } },
    orderBy: [{ pool: { name: "asc" } }, { role: "desc" }, { name: "asc" }],
  });
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, poolName: r.pool.name }));
}
