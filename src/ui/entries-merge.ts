import type { EntriesPageDto, EntryDto } from "@/domain/wire";

/** Older pages the user has loaded below the polled head. `anchor` is the cursor the first one was loaded with. */
export interface OlderEntries {
  anchor: number;
  entries: EntryDto[];
  nextCursor: number | null;
}

export interface MergedEntries {
  entries: EntryDto[];
  /** Where "Load more" continues from; null = nothing older. */
  nextCursor: number | null;
  /** false if the older block was dropped because the head no longer reaches it (a gap). */
  valid: boolean;
}

const bySeqDesc = (a: EntryDto, b: EntryDto) => b.seq - a.seq;

/**
 * The log = the freshly polled head page + the older pages already loaded, de-duplicated by seq
 * (the head wins) and newest first. The older block is only kept if it is still contiguous with
 * the head: the head's oldest seq must not be newer than the cursor the block was loaded from.
 */
export function mergeEntries(head: EntriesPageDto, older: OlderEntries | null): MergedEntries {
  const headOldest = head.entries.at(-1)?.seq;
  // Head already holds everything (no more pages), or there is no older block: just the head.
  if (head.nextCursor === null || older === null || older.entries.length === 0) {
    return { entries: [...head.entries].sort(bySeqDesc), nextCursor: head.nextCursor, valid: older === null };
  }
  if (headOldest !== undefined && headOldest > older.anchor) {
    // New entries outran the head page: seqs between the head and the older block are in neither.
    return { entries: [...head.entries].sort(bySeqDesc), nextCursor: head.nextCursor, valid: false };
  }
  const bySeq = new Map<number, EntryDto>();
  for (const entry of older.entries) bySeq.set(entry.seq, entry);
  for (const entry of head.entries) bySeq.set(entry.seq, entry); // head wins
  return { entries: [...bySeq.values()].sort(bySeqDesc), nextCursor: older.nextCursor, valid: true };
}

/** Adds a freshly loaded older page to the block (creating it on the first load). */
export function appendOlder(previous: OlderEntries | null, page: EntriesPageDto, cursorUsed: number): OlderEntries {
  const bySeq = new Map<number, EntryDto>();
  for (const entry of previous?.entries ?? []) bySeq.set(entry.seq, entry);
  for (const entry of page.entries) if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry);
  return {
    anchor: previous?.anchor ?? cursorUsed,
    entries: [...bySeq.values()].sort(bySeqDesc),
    nextCursor: page.nextCursor,
  };
}

export const PAGE_SIZE = 20;
/** The API's cap on `limit`. */
export const MAX_PAGE = 100;
/** Extra rows the poll asks for, to absorb entries that arrive between two polls. */
const POLL_MARGIN = 20;

/**
 * How many rows the poll should ask for. With no older pages loaded: exactly one page, so the log
 * never grows by itself. With older pages loaded: enough to reach back from the newest entry to
 * the older block (rows at or above its anchor) plus a margin for new arrivals, so the two stay
 * contiguous. Rows below the anchor are NOT counted, otherwise the request would grow with every poll.
 */
export function headLimit(merged: readonly EntryDto[], older: OlderEntries | null): number {
  if (older === null || older.entries.length === 0) return PAGE_SIZE;
  const reach = merged.filter((entry) => entry.seq >= older.anchor).length;
  return Math.min(MAX_PAGE, reach + POLL_MARGIN);
}
