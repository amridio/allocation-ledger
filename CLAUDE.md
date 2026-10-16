# Allocation Ledger: project rules

Field operations module. Operators log resource allocations from their phones. Allocations add to a shared unit pool. Each operator's running total sets a status level (critical/low/normal/high). Some allocations expire by operator tier. Supervisors correct past entries.

Stack: Next.js (App Router), TypeScript, Prisma, Postgres (Docker), TanStack Query, Tailwind, Zod, Vitest.

## Ledger rules (non-negotiable)

- The ledger table is **append-only**. Never `UPDATE` or `DELETE` ledger rows, in code or in migrations.
- Supervisor corrections are **new `ADJUSTMENT` rows** whose `refSeq` points at the entry they adjust (a `reason` is required). Rows are ordered by `seq`; `effectiveAt` is when it happened, `recordedAt` is when the server saw it.
- **Access boundary:** an operator sees only themselves; a supervisor sees and adjusts only their own pool; everything else is 403 (an unknown operator id is 403 too, so ids can't be probed). Every endpoint that shows an operator's data must get its subject operator from `requireAccessibleOperator()` in `src/server/api/access.ts`; `access-coverage.test.ts` fails for a route that doesn't. Writes are checked in the service (`adjust()`: `TARGET_OTHER_POOL`).
- A supervisor adjusts **only entries in their own pool** (403 otherwise), and an entry's **net units (original + all its adjustments + the new one) never go below zero** (422). The net-units check reads the earlier adjustments after taking the pool lock, so concurrent adjustments to one entry serialize.
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
- API handlers live in `src/server/api/`, are wrapped in `route()` (the one shared error handler), and signal failures by throwing `ApiError` / `failureError()`. Never build ad-hoc error responses, and never let a 500 carry a message or stack. Identity comes from `requireUser()` (the session cookie), never from the request body; `effectiveAt` / `expiresAt` are never accepted from clients. Every write `POST` requires the `Idempotency-Key` header.
- Next.js here is a version with breaking changes: read `node_modules/next/dist/docs/` before writing Next-specific code, and never swallow its control-flow errors in a catch (`unstable_rethrow`).

## Testing

- Vitest. Every `src/domain/` function has unit tests, including edge cases at status thresholds and expiry boundaries.
- Money-critical paths need a concurrency test against real Postgres: parallel writes, then assert the pool total equals the sum of ledger rows. Also test duplicate idempotency keys.
- `src/server/concurrency.int.test.ts` is the guarantee test and must always pass: 50 parallel allocations (balance == ledger sum), 20 parallel overflow attempts on a nearly full pool (balance never above capacity, watched during the run), and 5 parallel requests with one Idempotency-Key (exactly one row). It drives the real HTTP handlers against real Postgres, 5 fresh-pool rounds per scenario. Run it repeatedly after touching `allocate`, `adjust` or `ledger-tx`.
- Integration tests are named `*.int.test.ts` and run with `npm run test:int` against `TEST_DATABASE_URL` (the `ops_test` database; a guard refuses any name not ending in `_test` or equal to `DATABASE_URL`, so tests can never write to dev data); `npm test` stays fast and database-free. The ledger can't be cleaned up, so every integration test creates its own pool, tier and operator with unique ids.

## UI

- Phone-first and readable in bright sunlight: high contrast (aim for 7:1 or better), large tap targets, large numerals, light theme by default.
- Status is never conveyed by color alone. Each level has a distinct label and icon or shape.
- Pending (not yet confirmed) entries must look visibly pending.
- Sizes are written as explicit pixels, not rem (the root font is 18px): buttons and inputs at least 56px tall (48px is the floor), the metric number 72px, text 16px or larger. Colours come only from the tokens in `globals.css`; `src/ui/palette.test.ts` enforces 7:1 against the real tokens, so change a token and the test tells you.
- The screen is rendered on the server (`instant = false`, no Suspense) so first open has no loading state; the page gets its data through `loadDashboard()` and the shared `src/server/queries/*`, never its own queries. Times are formatted in the fixed `APP_TIMEZONE`, never the device's.
- After a write the screen replaces its optimistic number with the `metric` the server returned; it never adds to a number a poll may already have refreshed.
- Optimistic rows say **Syncing…**. A server REJECTION (non-retryable) rolls back: remove the row, drop its units from the metric, show a dismissible notice with the reason. No answer (retryable) keeps a **Not sent** row with Retry, reusing the same Idempotency-Key. Never offer Retry for a rejection.
- UI changes are verified with `npm run ui:check` (real Chromium, phone and desktop), not only by reading code. Run `npm run build` first, and never leave `next` servers running: stale ones silently serve an old build.

## Dependencies

- **Ask before adding any library**, including dev dependencies. Use the listed stack and the platform first.
