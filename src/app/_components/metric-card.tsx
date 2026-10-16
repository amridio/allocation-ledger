import type { MetricDto } from "@/domain/wire";
import type { StatusLevel } from "@/domain/status-config";
import { CARD } from "@/ui/styles";
import { ClockIcon, HourglassIcon } from "./icons";
import { StatusBadge } from "./status-badge";

/**
 * The headline: active units as a 72px number, with the status as colour + icon + word.
 * `activeUnits` / `status` may already include units that are still being sent (the caller
 * passes pendingCount so that is stated in words too).
 */
export function MetricCard({
  subjectName,
  activeUnits,
  status,
  pendingCount,
  pool,
  nextExpiryText,
  updatedAtText,
}: {
  subjectName: string;
  activeUnits: number;
  status: StatusLevel;
  pendingCount: number;
  pool: MetricDto["pool"];
  nextExpiryText: string;
  updatedAtText: string;
}) {
  const percent = pool.capacity === null || pool.capacity === 0 ? 0 : Math.min(100, Math.round((pool.activeUnits / pool.capacity) * 100));
  return (
    <section aria-labelledby="metric-heading" className={CARD} data-testid="metric-card">
      <h2 id="metric-heading" className="text-xl font-bold">
        {subjectName} · Active units
      </h2>
      <p
        data-testid="metric-value"
        aria-live="polite"
        className="my-3 text-[72px] font-extrabold leading-none tabular-nums"
      >
        {activeUnits}
      </p>
      <StatusBadge level={status} size="lg" testId="metric-status" />
      {pendingCount > 0 && (
        <p
          data-testid="metric-pending"
          className="mt-4 inline-flex items-center gap-2 rounded-lg border-4 border-dashed border-ink bg-pending-bg px-3 py-1 text-lg font-bold"
        >
          <HourglassIcon />
          Includes {pendingCount} still syncing…
        </p>
      )}

      <div className="mt-5 border-t-4 border-border pt-4">
        <p className="text-lg font-bold">Pool: {pool.name}</p>
        {pool.capacity === null ? (
          <p data-testid="pool-usage" className="text-lg">
            {pool.activeUnits} units in use · no capacity limit
          </p>
        ) : (
          <>
            <p data-testid="pool-usage" className="text-lg">
              {pool.activeUnits} of {pool.capacity} units in use ({percent}%)
            </p>
            <div
              role="meter"
              aria-label="Pool capacity in use"
              aria-valuemin={0}
              aria-valuemax={pool.capacity}
              aria-valuenow={pool.activeUnits}
              className="mt-2 h-6 w-full overflow-hidden rounded-full border-4 border-ink"
            >
              <div className="h-full bg-ink" style={{ width: `${percent}%` }} />
            </div>
          </>
        )}
      </div>

      <p data-testid="next-expiry" className="mt-4 flex items-center gap-2 text-lg font-bold">
        <ClockIcon />
        {nextExpiryText}
      </p>
      <p className="mt-1 text-base text-ink-soft">{updatedAtText}</p>
    </section>
  );
}
