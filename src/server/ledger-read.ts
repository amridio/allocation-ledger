import type { DomainEntry } from "@/domain/ledger";
import type { PrismaClient } from "@/generated/prisma/client";

/** All of an operator's ledger rows, in the shape the pure domain functions take. */
export async function loadOperatorEntries(db: PrismaClient, operatorId: string): Promise<DomainEntry[]> {
  const rows = await db.ledgerEntry.findMany({
    where: { operatorId },
    select: { seq: true, kind: true, units: true, effectiveAt: true, expiresAt: true, refSeq: true },
    orderBy: { seq: "asc" },
  });
  return rows;
}
