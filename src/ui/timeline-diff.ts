import type { TimelinePointDto } from "@/domain/wire";

export type { TimelinePointDto };

/**
 * Keys (the `at` strings) of the points in `next` that are new or differ from `previous` in
 * balance or status. Used to highlight what an adjustment recalculated. The very first load
 * (no previous timeline) flags nothing, and removed points aren't reported.
 */
export function changedPointKeys(previous: readonly TimelinePointDto[] | undefined, next: readonly TimelinePointDto[]): Set<string> {
  const changed = new Set<string>();
  if (!previous || previous.length === 0) return changed;
  const before = new Map(previous.map((p) => [p.at, p]));
  for (const point of next) {
    const old = before.get(point.at);
    if (!old || old.balance !== point.balance || old.status !== point.status) changed.add(point.at);
  }
  return changed;
}
