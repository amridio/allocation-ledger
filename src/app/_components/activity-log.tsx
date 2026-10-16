"use client";

import type { ReactNode } from "react";
import type { EntryDto } from "@/domain/wire";
import type { ApiClientError } from "@/ui/api-client";
import { describeExpiry, formatSigned } from "@/ui/format";
import type { OutboxItem } from "@/ui/outbox";
import { BTN_SECONDARY, CARD, HEADING } from "@/ui/styles";
import { formatWhen } from "@/ui/time";
import { AlertIcon, ClockIcon, ExpiredIcon, HourglassIcon, InfinityIcon, PlusIcon, RefreshIcon, SlidersIcon } from "./icons";
import { InlineAlert } from "./inline-alert";

interface Props {
  entries: EntryDto[];
  /** Allocations the user has submitted that the server hasn't confirmed yet (operators only). */
  outbox: OutboxItem[];
  namesById: Record<string, string>;
  now: Date;
  timeZone: string;
  /** Supervisors get an "Adjust" action on every allocation row. */
  canAdjust: boolean;
  onAdjust: (entry: EntryDto) => void;
  onRetry: (key: string) => void;
  onDismiss: (key: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadError: ApiClientError | null;
  onLoadMore: () => void;
  scopeText: string;
  /** Supervisors: the filter between "this operator" and "everyone". */
  scopeToggle?: ReactNode;
}

export function ActivityLog(props: Props) {
  const { entries, outbox } = props;
  return (
    <section aria-labelledby="log-heading" className={CARD} data-testid="activity-log">
      <h2 id="log-heading" className={HEADING}>
        Activity
      </h2>
      <p className="mb-3 text-lg" data-testid="log-scope-text">
        {props.scopeText}
      </p>
      {props.scopeToggle}

      {entries.length === 0 && outbox.length === 0 ? (
        <p className="text-lg font-bold" data-testid="log-empty">
          No activity yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {outbox.map((item) => (
            <PendingRow key={item.key} item={item} onRetry={props.onRetry} onDismiss={props.onDismiss} />
          ))}
          {entries.map((entry) => (
            <EntryRow key={entry.seq} entry={entry} {...props} />
          ))}
        </ul>
      )}

      {props.loadError && (
        <div className="mt-3">
          <InlineAlert>Couldn&apos;t load older entries: {props.loadError.message}</InlineAlert>
        </div>
      )}
      {props.hasMore && (
        <button
          type="button"
          data-testid="load-more"
          onClick={props.onLoadMore}
          disabled={props.loadingMore}
          className={`${BTN_SECONDARY} mt-4 w-full`}
        >
          {props.loadingMore ? "Loading older entries…" : "Load older entries"}
        </button>
      )}
    </section>
  );
}

function PendingRow({ item, onRetry, onDismiss }: { item: OutboxItem; onRetry: (k: string) => void; onDismiss: (k: string) => void }) {
  const failed = item.status === "failed";
  return (
    <li
      data-testid="pending-row"
      data-state={item.status}
      className={`rounded-xl border-4 border-dashed p-4 ${failed ? "border-danger bg-danger-bg" : "border-ink bg-pending-bg"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={`flex min-w-0 flex-wrap items-center gap-2 text-lg font-bold ${failed ? "text-danger" : ""}`}>
          {failed ? <AlertIcon /> : <HourglassIcon />}
          {failed ? "Not sent" : "Syncing…"}
        </p>
        <p className="shrink-0 text-3xl font-extrabold tabular-nums">{formatSigned(item.units)}</p>
      </div>
      {failed && item.error && <p className="mt-1 text-lg font-bold text-danger">{item.error.message}</p>}
      {failed && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <button type="button" data-testid="retry-button" onClick={() => onRetry(item.key)} className={BTN_SECONDARY}>
            <RefreshIcon /> Retry
          </button>
          <button type="button" data-testid="dismiss-button" onClick={() => onDismiss(item.key)} className={BTN_SECONDARY}>
            Dismiss
          </button>
        </div>
      )}
    </li>
  );
}

function EntryRow({ entry, namesById, now, timeZone, canAdjust, onAdjust }: { entry: EntryDto } & Props) {
  const isAdjustment = entry.kind === "ADJUSTMENT";
  const expiry = describeExpiry(entry.expiresAt, now);
  const ExpiryIcon = expiry.kind === "none" ? InfinityIcon : expiry.kind === "expired" ? ExpiredIcon : ClockIcon;
  const who = namesById[entry.operatorId] ?? "Unknown operator";
  return (
    <li
      data-testid="activity-row"
      data-seq={entry.seq}
      data-kind={entry.kind}
      data-expiry={expiry.kind}
      className="rounded-xl border-4 border-border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-lg font-bold">
          {isAdjustment ? <SlidersIcon /> : <PlusIcon />}
          {isAdjustment ? "Adjustment" : "Allocation"}
          <span className="text-base font-semibold text-ink-soft">#{entry.seq}</span>
        </p>
        <p data-testid="row-units" className="shrink-0 text-3xl font-extrabold tabular-nums">
          {formatSigned(entry.units)}
        </p>
      </div>
      <p className="mt-1 text-lg">
        {who} · {formatWhen(entry.effectiveAt, now, timeZone)}
      </p>
      {isAdjustment && (
        <>
          <p className="text-lg">
            Corrects #{entry.refSeq} · by {namesById[entry.createdById] ?? "a supervisor"}
          </p>
          <p data-testid="row-reason" className="text-lg font-bold">
            &ldquo;{entry.reason}&rdquo;
          </p>
        </>
      )}
      <p className="mt-1 flex items-center gap-2 text-lg font-bold" data-testid="row-expiry">
        <ExpiryIcon className="h-6 w-6" />
        {expiry.text}
      </p>
      {canAdjust && !isAdjustment && (
        <button
          type="button"
          data-testid="adjust-button"
          onClick={() => onAdjust(entry)}
          className={`${BTN_SECONDARY} mt-3 w-full`}
          aria-label={`Adjust entry #${entry.seq}, ${who}, ${formatSigned(entry.units)} units`}
        >
          <SlidersIcon /> Adjust
        </button>
      )}
    </li>
  );
}
