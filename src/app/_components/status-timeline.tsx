import type { TimelinePointDto } from "@/domain/wire";
import { CARD, HEADING } from "@/ui/styles";
import { formatWhen } from "@/ui/time";
import { ClockIcon, RefreshIcon } from "./icons";
import { StatusBadge } from "./status-badge";

/**
 * Status over time, newest first. Points after `now` are upcoming drops (an entry expiring).
 * After a supervisor's adjustment, the points that were recalculated are marked "Recalculated"
 * (a word + icon + heavy border, not just a colour) so the change is visible.
 */
export function StatusTimeline({
  points,
  changed,
  now,
  timeZone,
  view,
  bare = false,
}: {
  points: TimelinePointDto[];
  changed: ReadonlySet<string>;
  now: Date;
  timeZone: string;
  view: "transitions" | "full";
  /** No card frame and a screen-reader-only heading: for use inside the phone's "Status history" disclosure, which already has a title. */
  bare?: boolean;
}) {
  const newestFirst = [...points].reverse();
  return (
    <section aria-labelledby="timeline-heading" className={bare ? "" : CARD} data-testid="status-timeline">
      <h2 id="timeline-heading" className={bare ? "sr-only" : HEADING}>
        Status history
      </h2>
      <p className="mb-3 text-lg">{view === "full" ? "Every change in active units" : "When your status changed"}</p>
      {newestFirst.length === 0 ? (
        <p className="text-lg font-bold">Nothing yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {newestFirst.map((p) => {
            const isChanged = changed.has(p.at);
            const upcoming = new Date(p.at).getTime() > now.getTime();
            return (
              <li
                key={p.at}
                data-testid="timeline-point"
                data-at={p.at}
                data-changed={isChanged ? "true" : "false"}
                className={`rounded-xl border-4 p-3 ${
                  isChanged ? "border-ink bg-pending-bg" : "border-border"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-bold">{formatWhen(p.at, now, timeZone)}</p>
                    {upcoming && (
                      <p className="flex items-center gap-1 text-base font-bold">
                        <ClockIcon className="h-5 w-5" /> Upcoming
                      </p>
                    )}
                  </div>
                  <p className="text-3xl font-extrabold tabular-nums" data-testid="timeline-balance">
                    {p.balance}
                  </p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <StatusBadge level={p.status} />
                  {isChanged && (
                    <span
                      data-testid="recalculated-tag"
                      className="inline-flex items-center gap-2 rounded-lg border-4 border-ink bg-action px-3 py-1 text-lg font-bold text-action-text"
                    >
                      <RefreshIcon className="h-5 w-5" /> Recalculated
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
