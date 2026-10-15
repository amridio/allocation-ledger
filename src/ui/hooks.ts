"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EntriesPageDto, MetricDto, TimelineDto } from "@/domain/wire";
import { ApiClientError, type ApiClient } from "./api-client";
import { appendOlder, headLimit, mergeEntries, PAGE_SIZE, type OlderEntries } from "./entries-merge";

/** While the tab is hidden we only poll this often (focus brings an immediate refetch anyway). */
export const HIDDEN_POLL_MS = 30_000;
/** setTimeout can't take more than this; a longer wait just falls back to polling. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** Fire the expiry refetch a hair AFTER the expiry, so the server (whose clock decides) agrees it has expired. */
const EXPIRY_MARGIN_MS = 150;

/** Poll fast while the tab is visible, slowly while hidden. */
export function pollInterval(pollMs: number) {
  return () => (typeof document !== "undefined" && document.visibilityState === "hidden" ? HIDDEN_POLL_MS : pollMs);
}

/**
 * "What time is it, according to the SERVER?" Anchored to the server's `asOf` on every poll, so a
 * phone with a wrong clock still counts down and expires entries at the right moment. The first
 * render uses exactly the server's `asOf`, so server and browser render identical text.
 */
export function useServerClock(asOf: string) {
  const anchor = useRef({ serverMs: Date.parse(asOf), perf: 0 });
  const readNowMs = useCallback(() => anchor.current.serverMs + (performance.now() - anchor.current.perf), []);
  // The last tick, remembered with the asOf it belongs to: a newer poll (new asOf) resets the display to server time.
  const [ticked, setTicked] = useState<{ asOf: string; ms: number } | null>(null);

  const firstAnchor = useRef(true);
  useEffect(() => {
    // The first asOf was stamped by the server just before it sent the page, so anchor it to when the
    // response STARTED ARRIVING, not to the later moment this effect runs (that would run the clock
    // behind by the whole page-load time). Later asOf values come from polls and are anchored to "now".
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const arrived = firstAnchor.current && nav && nav.responseStart > 0 ? nav.responseStart : performance.now();
    anchor.current = { serverMs: Date.parse(asOf), perf: arrived };
    firstAnchor.current = false;
  }, [asOf]);

  useEffect(() => {
    const id = setInterval(() => setTicked({ asOf, ms: readNowMs() }), 15_000); // keeps "Expires in 5 min" honest between polls
    return () => clearInterval(id);
  }, [asOf, readNowMs]);

  const nowMs = ticked !== null && ticked.asOf === asOf ? ticked.ms : Date.parse(asOf);
  return {
    now: useMemo(() => new Date(nowMs), [nowMs]),
    readNowMs,
    refresh: () => setTicked({ asOf, ms: readNowMs() }),
  };
}

export function useMetric(api: ApiClient, subjectId: string, initial: MetricDto, pollMs: number) {
  return useQuery({
    queryKey: ["metric", subjectId],
    queryFn: () => api.getMetric(subjectId),
    initialData: initial,
    staleTime: 1_000,
    refetchInterval: pollInterval(pollMs),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
}

export function useTimeline(api: ApiClient, subjectId: string, view: "transitions" | "full", initial: TimelineDto) {
  return useQuery({
    queryKey: ["timeline", subjectId, view],
    queryFn: () => api.getTimeline(subjectId, view),
    initialData: initial,
    staleTime: 1_000,
  });
}

/**
 * Schedules a metric refetch for the moment the next entry expires, so the number and status change
 * right then instead of at the next poll. Re-arms itself on every new metric (the poll refreshes
 * `asOf` and the clock anchor, which also corrects the delay).
 */
export function useExpiryRefetch(
  nextExpiryAt: string | null,
  asOf: string,
  readNowMs: () => number,
  onExpiry: () => void,
) {
  const callback = useRef(onExpiry);
  useEffect(() => {
    callback.current = onExpiry;
  });
  useEffect(() => {
    if (nextExpiryAt === null) return;
    const delay = Date.parse(nextExpiryAt) - readNowMs() + EXPIRY_MARGIN_MS;
    if (delay > MAX_TIMEOUT_MS) return; // too far away: the poll will catch it
    const id = setTimeout(() => callback.current(), Math.max(0, delay));
    return () => clearTimeout(id);
  }, [nextExpiryAt, asOf, readNowMs]);
}

/**
 * The activity log: the newest page is polled and merged with any older pages the user loaded.
 * The poll asks for enough rows to reach back over everything already loaded, so new entries can't
 * push a loaded entry out of reach (see entries-merge.ts).
 */
export function useEntriesLog(api: ApiClient, scopeKey: string, initial: EntriesPageDto, pollMs: number) {
  const [older, setOlder] = useState<OlderEntries | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<ApiClientError | null>(null);
  const limit = useRef(PAGE_SIZE);

  const head = useQuery({
    queryKey: ["entries", scopeKey],
    queryFn: () => api.getEntries({ limit: limit.current }),
    initialData: initial,
    staleTime: 1_000,
    refetchInterval: pollInterval(pollMs),
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const merged = useMemo(() => mergeEntries(head.data, older), [head.data, older]);
  useEffect(() => {
    limit.current = headLimit(merged.entries, older); // the next poll reaches back over what is loaded, and no further
  }, [merged.entries, older]);

  const loadMore = useCallback(async () => {
    const cursor = merged.nextCursor;
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const page = await api.getEntries({ limit: PAGE_SIZE, cursor });
      // If new entries outran the poll the old block is stale (merged.valid is false): start a fresh one.
      setOlder((previous) => appendOlder(merged.valid ? previous : null, page, cursor));
    } catch (err) {
      setLoadError(err instanceof ApiClientError ? err : new ApiClientError(0, "NETWORK", "Couldn't load more.", true));
    } finally {
      setLoadingMore(false);
    }
  }, [api, merged.nextCursor, merged.valid, loadingMore]);

  return {
    entries: merged.entries,
    newestSeq: merged.entries[0]?.seq ?? 0,
    hasMore: merged.nextCursor !== null,
    loadMore,
    loadingMore,
    loadError,
  };
}

/** Invalidate the timeline whenever the metric or the log's newest entry changes (not on first render). */
export function useRefreshOnChange(signal: string, onChange: () => void) {
  const first = useRef(true);
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  });
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    callback.current();
  }, [signal]);
}

export { useQueryClient };
