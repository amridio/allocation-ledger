import { nextExpiryAt, operatorMetric } from "@/domain/metric";
import type { MetricDto } from "@/domain/wire";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AccessibleOperator } from "../api/access";
import { loadOperatorEntries } from "../ledger-read";
import { getActiveUnits } from "../ledger-tx";

/** The operator's headline numbers and their pool's, as of `now`. Authorize the subject first (access.ts). */
export async function getMetricDto(db: PrismaClient, subject: AccessibleOperator, now: Date): Promise<MetricDto> {
  const entries = await loadOperatorEntries(db, subject.id);
  const next = nextExpiryAt(entries, now);
  const pool = await db.pool.findUniqueOrThrow({ where: { id: subject.poolId } });
  return {
    asOf: now.toISOString(),
    operator: { id: subject.id, name: subject.name, ...operatorMetric(entries, now) },
    nextExpiryAt: next === null ? null : next.toISOString(),
    pool: {
      id: pool.id,
      name: pool.name,
      capacity: pool.capacity,
      activeUnits: await getActiveUnits(db, pool.id, now),
      lifetimeBalance: pool.balance,
    },
  };
}
