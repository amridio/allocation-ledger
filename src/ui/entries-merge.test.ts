import { describe, expect, it } from "vitest";
import type { EntriesPageDto, EntryDto } from "@/domain/wire";
import { appendOlder, headLimit, mergeEntries } from "./entries-merge";

const e = (seq: number): EntryDto => ({
  seq,
  kind: "ALLOCATION",
  operatorId: "op",
  poolId: "pool",
  createdById: "op",
  units: seq,
  effectiveAt: "2026-03-01T09:00:00.000Z",
  recordedAt: "2026-03-01T09:00:00.000Z",
  expiresAt: null,
  refSeq: null,
  reason: null,
  idempotencyKey: `k${seq}`,
});
/** A newest-first page; nextCursor is the oldest seq on it when more exist, like the API. */
const page = (seqs: number[], more: boolean): EntriesPageDto => ({
  entries: seqs.map(e),
  nextCursor: more ? (seqs.at(-1) ?? null) : null,
});
const seqsOf = (entries: EntryDto[]) => entries.map((x) => x.seq);

/*
 * The log polls the NEWEST page every few seconds and keeps older pages the user loaded.
 * Re-fetching every loaded page by its old cursor would silently drop an entry whenever new
 * entries push the old boundary entry out of the first page, so the pages are merged by seq.
 * (The poll also asks for enough rows to reach back over what is already loaded, so a gap only
 * happens if more new entries arrive between polls than the extra margin; then the stale older
 * pages are dropped rather than shown with a hole in them.)
 */
describe("mergeEntries", () => {
  it("with no older pages it is just the head", () => {
    expect(mergeEntries(page([9, 8, 7], true), null)).toMatchObject({ entries: page([9, 8, 7], true).entries, nextCursor: 7 });
  });

  it("appends older pages after the head, newest first", () => {
    const older = { anchor: 7, entries: [e(6), e(5), e(4)], nextCursor: 4 };
    const merged = mergeEntries(page([9, 8, 7], true), older);
    expect(seqsOf(merged.entries)).toEqual([9, 8, 7, 6, 5, 4]);
    expect(merged.nextCursor).toBe(4); // keep paging from where the older pages ended
  });

  it("detects a gap: new entries pushed the head's oldest past the older block, so entry 7 would be in neither; the stale older pages are dropped", () => {
    const older = { anchor: 7, entries: [e(6), e(5), e(4)], nextCursor: 4 };
    const merged = mergeEntries(page([10, 9, 8], true), older);
    expect(merged.valid).toBe(false);
    expect(seqsOf(merged.entries)).toEqual([10, 9, 8]);
    expect(merged.nextCursor).toBe(8); // paging restarts from the head: entry 7 will be fetched again
  });

  it("an overlapping head (it still reaches the older block) is merged and de-duplicated", () => {
    const older = { anchor: 7, entries: [e(6), e(5)], nextCursor: 5 };
    const merged = mergeEntries(page([10, 9, 8, 7, 6], true), older); // bigger head page than before
    expect(merged.valid).toBe(true);
    expect(seqsOf(merged.entries)).toEqual([10, 9, 8, 7, 6, 5]);
    expect(merged.nextCursor).toBe(5);
  });

  it("when the head already holds everything (no more pages) the older block is irrelevant", () => {
    const older = { anchor: 7, entries: [e(6)], nextCursor: null };
    const merged = mergeEntries(page([3, 2, 1], false), older);
    expect(seqsOf(merged.entries)).toEqual([3, 2, 1]);
    expect(merged.nextCursor).toBeNull();
  });

  it("an empty head is an empty log", () => {
    expect(mergeEntries({ entries: [], nextCursor: null }, null)).toMatchObject({ entries: [], nextCursor: null });
  });

  it("the head wins when the same seq appears in both", () => {
    const fresh = { ...e(7), reason: "from head" };
    const older = { anchor: 8, entries: [e(7), e(6)], nextCursor: 6 };
    const merged = mergeEntries({ entries: [e(9), e(8), fresh], nextCursor: 7 }, older);
    expect(merged.entries.find((x) => x.seq === 7)?.reason).toBe("from head");
  });
});

describe("appendOlder", () => {
  it("the first older page sets the anchor to the cursor it was loaded with", () => {
    const first = appendOlder(null, page([6, 5, 4], true), 7);
    expect(first).toEqual({ anchor: 7, entries: [e(6), e(5), e(4)], nextCursor: 4 });
  });

  it("later pages extend the block but keep the original anchor", () => {
    const first = appendOlder(null, page([6, 5, 4], true), 7);
    const second = appendOlder(first, page([3, 2], false), 4);
    expect(second.anchor).toBe(7);
    expect(seqsOf(second.entries)).toEqual([6, 5, 4, 3, 2]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not duplicate an entry that arrives twice", () => {
    const first = appendOlder(null, page([6, 5], true), 7);
    const again = appendOlder(first, page([5, 4], true), 5);
    expect(seqsOf(again.entries)).toEqual([6, 5, 4]);
  });
});

/*
 * How many rows the poll should ask for. With nothing older loaded it is exactly one page: the log
 * must NOT grow by itself (an earlier version asked for "loaded + margin", which counted its own
 * result as loaded and so loaded everything, page after page, without the user asking).
 */
describe("headLimit", () => {
  const rows = (seqs: number[]) => seqs.map(e);

  it("with no older pages loaded it is exactly one page, however often it is asked", () => {
    expect(headLimit(rows([20, 19, 18]), null)).toBe(20);
    expect(headLimit(rows(Array.from({ length: 20 }, (_, i) => 100 - i)), null)).toBe(20);
  });

  it("with older pages loaded it reaches back over the head's rows plus a margin for new entries", () => {
    const older = { anchor: 80, entries: rows([79, 78, 77]), nextCursor: 77 };
    // 5 rows at or above the anchor (80) -> 5 + 20 margin
    expect(headLimit(rows([84, 83, 82, 81, 80, 79, 78, 77]), older)).toBe(25);
  });

  it("counts only the rows above the anchor, so it does not grow just because older rows are loaded", () => {
    const older = { anchor: 80, entries: rows(Array.from({ length: 30 }, (_, i) => 79 - i)), nextCursor: 50 };
    const merged = rows([82, 81, 80, ...Array.from({ length: 30 }, (_, i) => 79 - i)]);
    expect(headLimit(merged, older)).toBe(23); // 3 above the anchor + 20, not 33 + 20
  });

  it("never asks for more than the API allows (100)", () => {
    const older = { anchor: 1, entries: rows([0]), nextCursor: null };
    expect(headLimit(rows(Array.from({ length: 150 }, (_, i) => 200 - i)), older)).toBe(100);
  });
});
