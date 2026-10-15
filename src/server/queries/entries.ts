import type { EntriesPageDto, EntryDto } from "@/domain/wire";
import type { LedgerEntry, PrismaClient } from "@/generated/prisma/client";

export type EntriesScope = { operatorId: string } | { poolId: string };

export function toEntryDto(row: LedgerEntry): EntryDto {
  return {
    seq: row.seq,
    kind: row.kind,
    operatorId: row.operatorId,
    poolId: row.poolId,
    createdById: row.createdById,
    units: row.units,
    effectiveAt: row.effectiveAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    refSeq: row.refSeq,
    reason: row.reason,
    idempotencyKey: row.idempotencyKey,
  };
}

/** One page of entries, newest first, paged by seq. The scope must already be authorized (access.ts). */
export async function getEntriesPageDto(
  db: PrismaClient,
  scope: EntriesScope,
  paging: { cursor?: number | undefined; limit: number },
): Promise<EntriesPageDto> {
  // One extra row tells us whether another page exists without a second count query.
  const rows = await db.ledgerEntry.findMany({
    where: { ...scope, ...(paging.cursor === undefined ? {} : { seq: { lt: paging.cursor } }) },
    orderBy: { seq: "desc" },
    take: paging.limit + 1,
  });
  const hasMore = rows.length > paging.limit;
  const page = hasMore ? rows.slice(0, paging.limit) : rows;
  return { entries: page.map(toEntryDto), nextCursor: hasMore ? (page.at(-1)?.seq ?? null) : null };
}
