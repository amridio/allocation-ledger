"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useState, type ComponentProps } from "react";
import { applyPendingUnits } from "@/domain/metric";
import type { EntriesPageDto, EntryDto } from "@/domain/wire";
import type { DashboardData } from "@/server/dashboard";
import { ApiClientError, createApiClient, type WriteResult } from "@/ui/api-client";
import { describeExpiry } from "@/ui/format";
import {
  useEntriesLog,
  useExpiryRefetch,
  useMetric,
  useRefreshOnChange,
  useServerClock,
  useTimeline,
} from "@/ui/hooks";
import { newIdempotencyKey } from "@/ui/idempotency";
import { initialOutbox, outboxReducer, pendingUnits } from "@/ui/outbox";
import { changedPointKeys } from "@/ui/timeline-diff";
import { formatClock } from "@/ui/time";
import { ActivityLog } from "./activity-log";
import { AdjustDialog, type AdjustBody } from "./adjust-dialog";
import { AppHeader } from "./app-header";
import { LogAllocationForm } from "./log-allocation-form";
import { LogAllocationSheet } from "./log-allocation-sheet";
import { MetricCard } from "./metric-card";
import { OperatorPicker } from "./operator-picker";
import { Providers } from "./providers";
import { StatusTimeline } from "./status-timeline";
import { StickyActionBar } from "./sticky-action-bar";

export interface UiConfig {
  pollMs: number;
  timeZone: string;
  switcherEnabled: boolean;
}

const HIGHLIGHT_MS = 8_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const asClientError = (err: unknown) =>
  err instanceof ApiClientError ? err : new ApiClientError(0, "NETWORK", "Couldn't reach the server.", true);

function allocationMessage(e: ApiClientError): string {
  switch (e.code) {
    case "CAPACITY_EXCEEDED":
      return "The pool is full: there isn't room for that many units.";
    case "NETWORK":
      return "No connection, so this wasn't confirmed. Retry: it won't be counted twice.";
    case "BUSY":
      return "The system is busy. Retry: it won't be counted twice.";
    default:
      return e.message;
  }
}

export function Dashboard(props: { data: DashboardData; config: UiConfig }) {
  return (
    <Providers>
      <Screen {...props} />
    </Providers>
  );
}

function Screen({ data, config }: { data: DashboardData; config: UiConfig }) {
  const api = useMemo(() => createApiClient(), []);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user, subject, operators } = data;
  const isSupervisor = user.role === "SUPERVISOR";
  const isSelf = subject.id === user.id;
  const view = isSupervisor ? "full" : "transitions";

  // ---- server data, kept fresh ----
  const metric = useMetric(api, subject.id, data.metric, config.pollMs).data;
  const log = useEntriesLog(api, data.entriesScope, data.entries, config.pollMs);
  const timeline = useTimeline(api, subject.id, view, data.timeline).data;
  const clock = useServerClock(metric.asOf);

  // The number changes the instant an entry expires: refetch exactly then, not at the next poll.
  useExpiryRefetch(metric.nextExpiryAt, metric.asOf, clock.readNowMs, () => {
    clock.refresh();
    void queryClient.invalidateQueries({ queryKey: ["metric", subject.id] });
  });
  // The history follows any change in the log or the numbers (other people's writes included).
  useRefreshOnChange(`${log.newestSeq}|${metric.pool.lifetimeBalance}|${metric.operator.activeUnits}`, () => {
    void queryClient.invalidateQueries({ queryKey: ["timeline", subject.id] });
  });

  // ---- which timeline points just changed (so an adjustment's recalculation is visible) ----
  const [track, setTrack] = useState({ subjectId: subject.id, points: timeline.points, changed: new Set<string>() });
  if (track.points !== timeline.points) {
    const sameOperator = track.subjectId === subject.id;
    const changed = sameOperator ? changedPointKeys(track.points, timeline.points) : new Set<string>();
    setTrack({ subjectId: subject.id, points: timeline.points, changed: changed.size > 0 ? changed : sameOperator ? track.changed : changed });
  }
  useEffect(() => {
    if (track.changed.size === 0) return;
    const id = setTimeout(() => setTrack((t) => ({ ...t, changed: new Set<string>() })), HIGHLIGHT_MS);
    return () => clearTimeout(id);
  }, [track.changed]);

  // ---- logging an allocation: instant, safe to retry ----
  const [outbox, dispatch] = useReducer(outboxReducer, initialOutbox);
  const [sheetOpen, setSheetOpen] = useState(false);

  const confirmAllocation = useCallback(
    async (key: string, result: WriteResult) => {
      // Replace the guess with the server's own figure; ignore any older in-flight poll.
      await queryClient.cancelQueries({ queryKey: ["metric", subject.id] });
      queryClient.setQueryData(["metric", subject.id], result.metric);
      queryClient.setQueryData<EntriesPageDto>(["entries", data.entriesScope], (page) =>
        page && !page.entries.some((e) => e.seq === result.entry.seq) ? { ...page, entries: [result.entry, ...page.entries] } : page,
      );
      dispatch({ type: "sent", key }); // same tick as the line above: one render, no dip and no double count
      void queryClient.invalidateQueries({ queryKey: ["timeline", subject.id] });
    },
    [queryClient, subject.id, data.entriesScope],
  );

  const sendAllocation = useCallback(
    async (key: string, units: number) => {
      for (let attempt = 0; ; attempt++) {
        let result: WriteResult;
        try {
          result = await api.postEntry(units, key); // the SAME key on every attempt
        } catch (err) {
          const e = asClientError(err);
          if (e.status === 401) router.refresh(); // session gone: the server will show sign-in
          if (e.retryable && attempt < 2) {
            await sleep((e.retryAfterSeconds ?? 1) * 1000);
            continue;
          }
          dispatch({ type: "failed", key, error: { code: e.code, message: allocationMessage(e) } });
          return;
        }
        await confirmAllocation(key, result);
        return;
      }
    },
    [api, confirmAllocation, router],
  );

  const logAllocation = (units: number) => {
    const key = newIdempotencyKey();
    dispatch({ type: "add", key, units });
    void sendAllocation(key, units);
  };
  const retryAllocation = (key: string) => {
    const item = outbox.items.find((i) => i.key === key);
    if (!item) return;
    dispatch({ type: "retry", key });
    void sendAllocation(key, item.units); // same key: if the first attempt did land, the server just replays it
  };

  // ---- supervisor: adjust a past entry ----
  const [adjustTarget, setAdjustTarget] = useState<EntryDto | null>(null);
  const startAdjust = (entry: EntryDto) => {
    if (entry.operatorId !== subject.id) router.replace(`/?operator=${encodeURIComponent(entry.operatorId)}`); // so the history behind the dialog is theirs
    setAdjustTarget(entry);
  };
  const submitAdjustment = useCallback(
    async (body: AdjustBody, key: string) => {
      const result = await api.postAdjustment(body, key); // throws ApiClientError: the dialog shows it
      const operatorId = result.metric.operator.id;
      await queryClient.cancelQueries({ queryKey: ["metric", operatorId] });
      queryClient.setQueryData(["metric", operatorId], result.metric);
      queryClient.setQueryData<EntriesPageDto>(["entries", data.entriesScope], (page) =>
        page && !page.entries.some((e) => e.seq === result.entry.seq) ? { ...page, entries: [result.entry, ...page.entries] } : page,
      );
      // Re-reading the history is what lets the page highlight the points that were recalculated.
      await queryClient.invalidateQueries({ queryKey: ["timeline", operatorId] });
    },
    [api, queryClient, data.entriesScope],
  );

  // ---- what to show ----
  const namesById = useMemo(() => {
    const names: Record<string, string> = { [user.id]: user.name };
    for (const o of operators ?? []) names[o.id] = o.name;
    return names;
  }, [user.id, user.name, operators]);

  const sending = pendingUnits(outbox);
  const shown = isSelf ? applyPendingUnits(metric.operator, sending) : metric.operator;
  const nextExpiry = metric.nextExpiryAt === null ? null : describeExpiry(metric.nextExpiryAt, clock.now);
  const nextExpiryText =
    nextExpiry === null
      ? "No upcoming expiry"
      : nextExpiry.kind === "expired"
        ? "Next expiry: now"
        : `Next expiry: ${nextExpiry.text.replace(/^Expires /, "")}`;
  const updatedAtText = `Updated ${formatClock(metric.asOf, config.timeZone)}`;
  const adjustName = adjustTarget ? (namesById[adjustTarget.operatorId] ?? "Unknown operator") : "";

  const timelineProps: ComponentProps<typeof StatusTimeline> = { points: timeline.points, changed: track.changed, now: clock.now, timeZone: config.timeZone, view };

  return (
    <div className="mx-auto w-full max-w-[1400px] p-4 pb-40 lg:p-8 lg:pb-8">
      <AppHeader name={user.name} role={user.role} switcherEnabled={config.switcherEnabled} />
      <div className="sr-only" aria-live="polite" data-testid="announcer">
        {track.changed.size > 0 ? `${track.changed.size} status history ${track.changed.size === 1 ? "point was" : "points were"} recalculated.` : ""}
      </div>

      <div className="mt-4 flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)] lg:items-start lg:gap-6">
        {/* column 1: the form (operators; on a phone it lives in the bottom sheet) or the operator picker (supervisors) */}
        {isSupervisor && operators ? (
          <OperatorPicker operators={operators} selectedId={subject.id} />
        ) : (
          <div className="hidden lg:block" data-testid="desktop-form">
            <LogAllocationForm idPrefix="desktop" framed onSubmit={logAllocation} />
          </div>
        )}

        {/* column 2: the metric, then its history */}
        <div className="flex flex-col gap-4">
          <MetricCard
            subjectName={subject.name}
            activeUnits={shown.activeUnits}
            status={shown.status}
            pendingCount={isSelf ? sending.length : 0}
            pool={metric.pool}
            nextExpiryText={nextExpiryText}
            updatedAtText={updatedAtText}
          />
          <details className="rounded-2xl border-4 border-border lg:hidden" data-testid="timeline-disclosure">
            <summary className="flex min-h-[56px] cursor-pointer items-center px-5 text-xl font-bold">
              Status history ({timeline.points.length})
            </summary>
            <div className="p-3">
              <StatusTimeline {...timelineProps} bare />
            </div>
          </details>
          <div className="hidden lg:block">
            <StatusTimeline {...timelineProps} />
          </div>
        </div>

        {/* column 3: the activity log */}
        <ActivityLog
          entries={log.entries}
          outbox={outbox.items}
          namesById={namesById}
          now={clock.now}
          timeZone={config.timeZone}
          canAdjust={isSupervisor}
          onAdjust={startAdjust}
          onRetry={retryAllocation}
          onDismiss={(key) => dispatch({ type: "dismiss", key })}
          hasMore={log.hasMore}
          loadingMore={log.loadingMore}
          loadError={log.loadError}
          onLoadMore={() => void log.loadMore()}
          scopeText={isSupervisor ? `Everyone in ${metric.pool.name}` : "Your allocations and corrections"}
        />
      </div>

      {!isSupervisor && (
        <>
          <StickyActionBar onClick={() => setSheetOpen(true)} />
          <LogAllocationSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onSubmit={logAllocation} />
        </>
      )}

      {adjustTarget && (
        <AdjustDialog
          key={adjustTarget.seq}
          target={adjustTarget}
          operatorName={adjustName}
          now={clock.now}
          timeZone={config.timeZone}
          onClose={() => setAdjustTarget(null)}
          onSubmit={submitAdjustment}
        />
      )}
    </div>
  );
}
