# Trade-Off Document (Brief)

**Project:** Allocation Ledger, first version. **Audience:** the client team and the engineers who will take it over.
**Purpose:** to record where the brief was open to interpretation, what we decided in those places, and why the database and the screen are shaped the way they are. Every decision below can be reversed; the last column of the first table says how much that would cost.

## 1. The brief

> **1. The Operational Dashboard.** Operators must be able to submit new allocations, view their live running metric, and inspect an activity log on both mobile and desktop. *"It needs to feel instant, never show wrong totals even if multiple operators are logging actions at the exact same moment, and be effortless for someone using a phone under bright sunlight in a warehouse."*
>
> **2. Business Logic.** Certain logged allocations have variable expiration windows based on operator tiers. Periodically, supervisor adjustments can retroactively alter past entries, which must recalculate downstream status levels.

## 2. Ambiguities we found, and what we assumed

| # | Ambiguity in the brief | Our assumption | Cost to change |
|---|------------------------|----------------|----------------|
| 1 | **"Feel instant"** has no number. | The screen reacts in the same tap (it shows the new total at once, marked *Syncing…*), and the first page load already contains the numbers. We did not set a millisecond target. | Low: a target can be added to the browser checks. |
| 2 | **"Never show wrong totals"**: which totals, and is an unconfirmed total "wrong"? | Two promises. The *confirmed* total is never wrong, even under simultaneous writes. An *unconfirmed* total is allowed only if it is visibly marked as such (dashed border, "includes N still syncing"), and the server's figure always replaces it. | Medium: it is a product rule as much as a technical one. |
| 3 | **"Live running metric"**: what is it? | The operator's *active* units (not expired) and the status level derived from them, with the pool's usage next to it. | Low. |
| 4 | **Status levels** are named in the brief ("downstream status levels") but their thresholds are not given. | Placeholders: critical below 20, low 20 to 49, normal 50 to 99, high 100 and above. Kept in one file, `src/domain/status-config.ts`. | Low: one file plus its boundary tests. |
| 5 | **"Variable expiration windows based on operator tiers"**: which tiers, which windows, counted from when? | T1 24 h, T2 72 h, T3 never. Counted from when the allocation *happened* (`effectiveAt`), not when the server received it. An entry counts up to, but not including, its expiry instant. The window is fixed when the entry is created, so changing a tier later does not rewrite old entries. | Low for the numbers (a table); medium for "recompute old entries", which we deliberately do not do. |
| 6 | **Does an expired allocation still count against the pool's capacity?** The brief mentions a shared pool but not a limit. | Capacity is optional and measured in *active* units. Expired units no longer hold space. | Low. |
| 7 | **At capacity: reject or warn?** | Reject (422); the screen rolls the number back and says why. Reaching capacity exactly is allowed. This is the assumption we most want the client to confirm. | Low in code, but it changes how operators work. |
| 8 | **"Periodically"**, supervisor adjustments: how often, and by whom? | We treat it as "at any time", by supervisors only, within their own pool. Operators never adjust. | Low. |
| 9 | **"Retroactively alter past entries"**: edit the entry, or correct it? | Correct it. The original stays; an adjustment is a new, signed row dated at the original entry's time, with a mandatory reason, that expires with it. An entry's net units can never go below zero. | High to reverse: it underpins the audit trail. |
| 10 | **"Recalculate downstream status levels"**: which ones, and how visible? | Every status from the corrected moment onward, for that operator. The supervisor sees exactly which history points changed (*Recalculated*). Operators see their own status history as transitions only. | Low. |
| 11 | **"Inspect an activity log"**: whose entries? | Operators see their own. A supervisor sees one selected operator by default, with a toggle for the whole pool. | Low. |
| 12 | **"Effortless in bright sunlight"** is not measurable. | We turned it into rules that a test can fail: text contrast of at least 7:1, tap targets of at least 56 px, text of at least 16 px, a 72 px headline number, light theme, and status never shown by colour alone. | Low. |
| 13 | **Who is logged in** is not mentioned. | A temporary "Switch user" screen, off unless enabled. It identifies people but does not authenticate them. | Medium: real login is a planned next step. |

## 3. Why the database looks the way it does

**An append-only ledger instead of a "total" column.** The brief asks for totals that are never wrong *and* for retroactive corrections. Both are easiest to guarantee if nothing is ever overwritten: the ledger is the single source of truth, and a database trigger rejects any `UPDATE` or `DELETE` on it. Corrections are new rows that point at the entry they correct, so who changed what, when and why is always recoverable.

**Two timestamps and a sequence.** `effectiveAt` is when it happened in the field; `recordedAt` is when the server saw it; `seq` gives a strict order. Expiry and status follow `effectiveAt`, so a late or backdated record behaves as if it had been logged on time.

**Status and history are computed on read, never stored.** A stored status per entry would have to be recalculated after every correction. Computing it from the ledger means a correction is correct the instant it is written, and no background job can be forgotten or fall behind. The price is read cost, which grows with the length of an operator's history (see section 5).

**The expiry date is stored on the entry, once.** Unlike status, expiry must not change when a tier is edited later, so it is calculated at creation from the operator's tier *at that time*. The windows themselves live in a `tier` table, so they can change without a deployment.

**One cached number, updated in the same transaction.** The pool's `balance` is the only stored aggregate. It is changed only by `balance = balance + n`, in the same transaction as the insert, never read and written back by application code.

**A row lock per pool, taken before checking.** "The exact same moment" is the hard part of the brief. Every write locks its pool row first and only then checks the idempotency key, the capacity or the "not below zero" rule. Two requests cannot both see "there is room" and both take it. Different pools never wait for each other. We proved this rather than assumed it: the concurrency suite passes 20 of 20 with the lock and fails 10 of 20 without it (overflow and double-adjustment scenarios).

**An idempotency key on every write.** Phones lose signal. A retry with the same key returns the original result and is never counted twice, even if only the answer was lost. The key is unique per creator in the database, which is the last line of defence.

## 4. Why the screen looks the way it does

| Choice | Reason |
|--------|--------|
| **Server-rendered first page, no loading state** | "Instant" starts at first open: the HTML already contains the numbers. |
| **Optimistic update, marked *Syncing…*, then replaced by the server's figure** | The tap feels immediate, yet the confirmed total is always the server's. The write's answer carries the new metric, so the screen never adds to a number a poll may already have refreshed. |
| **Two different failures, two different screens** | A *refusal* (pool full) is rolled back with a clear notice and no Retry, because retrying cannot help. *No answer* (no signal) keeps a **Not sent** row with Retry, which reuses the same key and cannot double count. |
| **One large number (72 px) with status as colour *and* shape *and* word** | Readable at arm's length in glare, and usable by people who cannot distinguish the colours. |
| **Bottom sheet on phones, side column on desktop** | The primary button and the form sit within thumb reach; the same components serve both sizes. |
| **Supervisor log filtered to the selected operator** | To correct an entry you should not have to page through other people's rows. |
| **Polling every 3 s, plus a refetch at the exact expiry moment** | Simple and robust. The server says when the next entry expires, so the number changes at that moment, not at the next poll. |
| **Fixed time zone for every screen** | The server-rendered page and the browser must print identical text. |

## 5. Trade-offs we accepted in this version

- **Polling, not push.** Up to about 3 s of staleness, and two small requests per open screen every 3 s. We pause polling while the user's own write is in flight, because a poll landing between the server's commit and its answer would count the entry twice. The proper fix is to reconcile by `seq` (ignore data older than the last confirmed write), which also prepares a move to server-sent events.
- **No stored projections.** The metric stays at about 20 to 35 ms from 1,000 to 100,000 entries; the supervisor's full status history takes about 30 ms at 1,000 entries, 90 ms at 10,000 and 1.5 s at 100,000 (one operator, measured on a small VM). A busy operator needs roughly seven months to reach 10,000 entries. If that ever matters, a stored timeline snapshot is a contained addition, because the ledger remains the source of truth.
- **Temporary authentication.** Fine for a demonstration, not for real data. One function (`requireUser()`) is the place to replace it.
- **Unsent entries live in the page.** A "Not sent" row survives a bad connection but not a page reload. Persisting that queue is planned.
- **Writes to one pool run one at a time.** That is the price of never showing a wrong total; the lock is held only for a few queries, and we have not yet load-tested at the client's real volumes.

## 6. What we need from the client

1. Confirm or replace the **status thresholds** and the **tier windows** (section 2, rows 4 and 5).
2. Decide **reject or warn** at capacity, and whether capacity is per pool (rows 6 and 7).
3. Confirm the **definition of the metric** and who may see whose log (rows 3 and 11).
4. Give us **realistic volumes** (operators per pool, entries per day) so we can load-test and decide whether a stored timeline is ever needed.

*More detail: the [README](../README.md) (how to run it, a ten-minute walkthrough, the concurrency result) and [`CLAUDE.md`](../CLAUDE.md) (the project rules).*
