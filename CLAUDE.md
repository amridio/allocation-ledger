# Allocation Ledger: project rules

Field operations module. Operators log resource allocations from their phones. Allocations add to a shared unit pool. Each operator's running total sets a status level (critical/low/normal/high). Some allocations expire by operator tier. Supervisors correct past entries.

Stack: Next.js (App Router), TypeScript, Prisma, Postgres (Docker), TanStack Query, Tailwind, Zod, Vitest.

## Ledger rules (non-negotiable)

- The ledger table is **append-only**. Never `UPDATE` or `DELETE` ledger rows, in code or in migrations.
- Supervisor corrections are **new `ADJUSTMENT` rows** whose `refSeq` points at the entry they adjust (a `reason` is required). Rows are ordered by `seq`; `effectiveAt` is when it happened, `recordedAt` is when the server saw it.
- Every write carries a client-generated **idempotency key**, unique per creator (`createdById`, `idempotencyKey`). A retry with the same key returns the original result and must not double count.
- Inserting a ledger row and updating the pool's cached `balance` happen in **one transaction**. Lock the pool row with `SELECT ... FOR UPDATE` before inserting (this also keeps `seq` in commit order within a pool). Update the balance with `balance = balance + n`. Never read a total, compute in app code, and write it back.
- **Expiry date is calculated once, when the entry is created**, from the operator's tier at that time, and stored on the row. Do not recompute it later.
- **Status history is derived from the ledger on read** (ordered running total against thresholds). Never store per-entry status, so retroactive adjustments need no recalculation job.
- "Now" is always injected. Domain code never calls `Date.now()` or `new Date()` directly.

## Architecture

- All business logic lives in `src/domain/` as **pure functions**: no I/O, no Prisma, no `Date.now()`, no framework imports. Running totals, status thresholds, expiry, and correction handling go here.
- Route handlers and server actions are **thin**: parse input with Zod, call domain and data-access code, return the result. No business rules in handlers or components.
- The client reuses the same `src/domain/` functions for optimistic updates. The server response is always the source of truth and overrides the optimistic value.
- Zod schemas are the single source of input types. Derive TypeScript types from them.

## Testing

- Vitest. Every `src/domain/` function has unit tests, including edge cases at status thresholds and expiry boundaries.
- Money-critical paths need a concurrency test against real Postgres: parallel writes, then assert the pool total equals the sum of ledger rows. Also test duplicate idempotency keys.
- Integration tests are named `*.int.test.ts` and run with `npm run test:int` against `TEST_DATABASE_URL`; `npm test` stays fast and database-free. The ledger can't be cleaned up, so every integration test creates its own pool, tier and operator with unique ids.

## UI

- Phone-first and readable in bright sunlight: high contrast (aim for 7:1 or better), large tap targets, large numerals, light theme by default.
- Status is never conveyed by color alone. Each level has a distinct label and icon or shape.
- Pending (not yet confirmed) entries must look visibly pending.

## Dependencies

- **Ask before adding any library**, including dev dependencies. Use the listed stack and the platform first.
