import { statusTimeline, statusTransitions } from "@/domain/ledger";
import type { TimelineDto } from "@/domain/wire";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AccessibleOperator } from "../api/access";
import { loadOperatorEntries } from "../ledger-read";

/** An operator's status over time. `transitions` = only status changes; `full` = every balance change. */
export async function getTimelineDto(
  db: PrismaClient,
  subject: AccessibleOperator,
  view: "transitions" | "full",
  now: Date,
): Promise<TimelineDto> {
  const entries = await loadOperatorEntries(db, subject.id);
  const points = (view === "full" ? statusTimeline(entries) : statusTransitions(entries)).map((p) => ({
    at: p.at.toISOString(),
    balance: p.balance,
    status: p.status,
  }));
  return { operatorId: subject.id, view, asOf: now.toISOString(), points };
}
