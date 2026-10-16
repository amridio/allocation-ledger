# Allocation Ledger

Field operations module. Operators log resource allocations from their phones; allocations add to a shared unit pool; each operator's running total sets a status level. Project rules are in [`CLAUDE.md`](./CLAUDE.md).

Stack: Next.js (App Router), TypeScript, Prisma 7 + Postgres 16, TanStack Query, Tailwind, Zod, Vitest.

## Local setup

```bash
cp .env.example .env
docker compose up -d --wait      # Postgres 16 (dev + test databases)
npm install                      # also runs `prisma generate`
npm run db:migrate               # apply migrations
npm run db:seed:demo             # tiers + demo operators and entries (or db:seed for tiers only)
npm run dev
```

Checks: `npm run typecheck`, `npm run lint`, `npm test` (fast unit tests, no database needed).

**Lost tests.** `npm run test:count` runs both suites and compares the number of tests per file with the counts committed in `test-counts.json` (the last commit's version is the "before"). It fails if a file lost tests, a file disappeared, tests were turned into `.skip`, or the baseline is stale. The pre-commit hook in `.githooks/` runs it (`npm install` points git at it: `git config core.hooksPath .githooks`); a commit with no code staged skips it. After adding tests run `npm run test:count -- --update` and stage `test-counts.json`. A deliberate removal needs `ALLOW_TEST_REMOVAL=1 git commit` on top of the updated baseline, so the diff of `test-counts.json` records it. `SKIP_INT_COUNT=1` skips the integration suite (it needs Docker Postgres) and says so. A count can't tell which test a rename replaced; it catches deletions, not swaps.

Integration tests run against real Postgres, in a separate database (`TEST_DATABASE_URL`, `ops_test` by default, created by the Docker init script and migrated automatically): `npm run test:int`. They never touch the dev database, and a guard refuses to run unless the database name ends in `_test` and differs from `DATABASE_URL`. The ledger is append-only, so these tests can't clean up after themselves. Each test creates its own pool, tier and operator, and `ops_test` just grows. To reset everything: `docker compose down -v && docker compose up -d --wait` (this also recreates the dev database; re-run `npm run db:deploy && npm run db:seed:demo`). `src/server/concurrency.int.test.ts` holds the money-critical guarantees (50 parallel allocations, overflow attempts on a full pool, repeated idempotency keys, two supervisors adjusting one entry); run it repeatedly after touching the write path.

### Database connection pool

`DATABASE_POOL_SIZE` (default `10`) is the maximum number of Postgres connections **one app instance** may hold. Size it so that *instances × pool size* stays well below Postgres's `max_connections` (default 100), leaving room for migrations and admin sessions. More connections do **not** make a single busy pool faster: writes to one pool run one at a time behind its row lock, and each waiting write holds a connection while it waits. If the pool is too small, requests queue for a connection and a write that waits more than 2 s gets `503 BUSY` (safe to retry); too large across many instances, and Postgres refuses connections. If the app runs as many short-lived instances (serverless), keep it small and put a connection pooler such as PgBouncer in front. A value that isn't a whole number >= 1 makes API requests fail with a 500 (the reason is in the server log). On a local database the whole concurrency suite, including 50 parallel writes, passes with a pool as small as 1, so start at the default and raise it only if you see `503 BUSY` while the database itself is idle.

### Seeding

```bash
npm run db:seed        # tiers T1/T2/T3 only
npm run db:seed:demo   # tiers + demo people and 20 past ledger entries
```

Tier expiry is the same either way: **T1 = 24 hours, T2 = 72 hours, T3 = never** (see the defaults below). The one exception is for testing: with `SEED_SHORT_EXPIRY=true`, T1 is **2 minutes** instead, so you can watch expiry happen.

```bash
SEED_SHORT_EXPIRY=true npm run db:seed:demo
```

`db:seed:demo` adds 4 operators, 1 supervisor, and 17 allocations plus 3 supervisor adjustments in the `main` pool. Some entries are already expired when it runs (under the defaults, the oldest T1 and T2 entries; in short mode, nearly all T1 entries).

Both seeds are safe to run repeatedly. Tiers and people are upserted, ledger entries use fixed idempotency keys and are skipped if present, and the pool balance only grows by rows actually inserted. An entry's expiry is fixed when it is created, so `SEED_SHORT_EXPIRY` only affects demo entries inserted on that run. To start over with different settings, recreate the database:

```bash
docker compose down -v && docker compose up -d --wait
npm run db:deploy && SEED_SHORT_EXPIRY=true npm run db:seed:demo
```

Running a seed overwrites expiry for T1–T3, and the demo / short-expiry modes are refused when `NODE_ENV=production`. Never run a seed against production data.

## The screen

Open `http://localhost:3000`. It is built for phones in a bright warehouse, possibly worn with gloves.

**Operators** (phone): the metric on top (active units as a 72px number with its status), the activity log below it, and a big **Log allocation** button pinned to the bottom edge. It opens a bottom sheet with a large numeric field, +1/+5/+10 buttons and a confirm button. **Desktop**: three columns: the form, the metric with its status history, the activity log.

**Supervisors**: an operator picker, the selected operator's full status history, and an activity log that shows **only that operator's entries** by default (so the entry to correct is right there, not buried under other people's rows). The **Everyone** toggle widens it to the whole pool; the choice is kept in the URL (`?operator=…&log=all`) and survives changing operator. The filter is the `operatorId` parameter of `GET /api/entries` (same-pool check, 403 otherwise). Every allocation row has an **Adjust** button, which opens a **bottom sheet** on a phone (buttons in thumb reach) and a centred dialog on a desktop: choose *Remove* or *Add* units, enter the amount and a required reason. The history then shows exactly which points were **Recalculated** (an adjustment is dated at the entry it corrects, so only that moment and later change; earlier points never do).

What you can rely on:

- **No loading state on first open.** The page is rendered on the server (`instant = false`, no Suspense fallback), so the first HTML response already contains the numbers. A test fetches it with JavaScript off.
- **Instant, and never wrong.** Logging shows the new total at once, with a visible **Syncing…** row (dashed border, hourglass) and a dashed "includes N still syncing" note on the metric. When the server confirms, its own figure (returned in the response) replaces the guess in a single update, so the number never dips or counts twice. Two different bad outcomes: if the **server rejects** it (pool full, not allowed), the row is removed, the total goes back to what it was, and a red notice says why ("Not logged: 600 units. The pool is full…"; it floats at the top until dismissed, and offers no Retry because retrying can't help). If there was **no answer** (offline, busy), the entry may still be valid, so the row stays as **Not sent** with a **Retry** button that re-sends with the *same* `Idempotency-Key`: it can never double count.
- **Fresh.** While the tab is visible it polls every 3 s (`UI_POLL_MS`), every 30 s while hidden, and refetches on focus. Separately, the metric endpoint returns `nextExpiryAt`, and the screen schedules a refetch for that exact moment (against a clock anchored to the server's, so a phone with a wrong clock still expires entries at the right time), so the number and status change when an entry expires, not at the next poll.
- **Status is never colour alone.** Every status is a colour *and* an icon with its own shape (octagon, down triangle, check circle, up triangle) *and* a word.
- **Warehouse design rules:** dark text on white, no light-grey text, 7:1 contrast or better (a unit test reads the real colour tokens and fails if one breaks the rule), text 16px or larger, buttons and inputs at least 56px tall.

### Environment variables for the screen

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `ENABLE_USER_SWITCHER` | **off** (anything but `true`) | The temporary "Switch user" screen **and** `POST /api/switch-user`. With it off, the endpoint answers 404 and the page just says sign-in isn't available. `.env.example` sets it to `true` for local work. Keep it off anywhere real data lives. |
| `UI_POLL_MS` | `3000` | How often a visible screen polls (500 or more). |
| `APP_TIMEZONE` | `UTC` | The IANA time zone times are shown in (for example `Europe/Berlin`). It is fixed, not "the device's zone", so the server-rendered page and the browser print identical text. |

Each open screen makes about two small requests every 3 s (the metric and the newest page of the log). Keep that in mind when sizing the database pool for many simultaneous users.

### Checking it in a real browser

`npm run ui:check` (needs `npm run build` first) starts the production server against the `ops_test` database and drives Chromium (via `playwright-core`) at a phone size and a desktop size. It checks layout order, that every control is at least 48px tall, the contrast of every piece of text, that statuses carry an icon and a word, first open with JavaScript off, logging with a held-open request (the number must show exactly `5` then `25`, never flicker or double count), a real rejection rolling the number back with an error, retry with the same key, that nothing spills out of its card (including text running past a block's edge; rows, history points, the adjust sheet, on phone and desktop), a poll landing mid-write (no double count, no erased row), double taps (one request), the narrowest phone (360px, a 7-digit total, a very long name, the sheets), the supervisor's log filter (default one operator, Everyone, paging, polling only into the right log) and the adjust bottom sheet's position and thumb reach, the supervisor's adjustment recalculating the history, and the exact-moment expiry refetch. Screenshots go to `./ui-check-output`.

## Business defaults: TO CONFIRM WITH CLIENT

The client has not given exact numbers yet. Everything below is a **placeholder default**.

**Status cutoffs** (measured in active, i.e. non-expired, units). Defined in one place: [`src/domain/status-config.ts`](./src/domain/status-config.ts). If they change, update that file and the boundary tests in `src/domain/status.test.ts`.

| Status   | Active units |
| -------- | ------------ |
| CRITICAL | below 20     |
| LOW      | 20 to 49     |
| NORMAL   | 50 to 99     |
| HIGH     | 100 and above |

**Expiry per operator tier.** Stored on the `tier` table (`expiry_minutes`, null = never), so it can be changed without a deploy. Seeded by [`prisma/seed.mjs`](./prisma/seed.mjs).

| Tier | Expiry          |
| ---- | --------------- |
| T1   | 24 hours        |
| T2   | 72 hours        |
| T3   | never (null)    |

An entry's `expires_at` is calculated once, when it is created, from the operator's tier at that time (`src/domain/expiry.ts`). Changing a tier's expiry later does not alter existing entries.

## Assumptions

Decided by us while building; the client has not seen these yet, so confirm them with the client.

- **Expiry boundary.** An entry counts from `effective_at` up to, but not including, `expires_at`. At exactly `expires_at` it is already expired. Nothing is counted twice at the boundary: if one entry expires at the instant its replacement takes effect, only the replacement counts. (Implemented and explained in `src/domain/ledger.ts`; the same rule applies to the capacity check.)
- **Expiry base time.** Expiry is counted from `effective_at` (when it happened in the field), not from when the server recorded it.
- **Adjustments.** A supervisor adjustment is a signed ledger entry that takes effect at its own `effective_at` and expires together with the entry it adjusts (`adjust()` and the seed both implement this). The service copies the target's `effective_at` and `expires_at`, so every adjustment is backdated to the entry it corrects. Backdating an adjustment changes the balance and status from that moment on, never before it.
- **Capacity** is measured in active (non-expired) units, not the cached `balance`. An allocation that would exceed it is **rejected** (422); the service assumes rejecting rather than warning, so confirm that with the client. Reaching capacity exactly is allowed.
- **Timeouts.** A pool-lock timeout (3 s) and a whole-transaction timeout (5 s) both return `503` with `Retry-After: 1`; retrying with the same key is always safe.
- **Two history views.** Supervisors see every balance change (`statusTimeline`). Operators see only the points where their status changes (`statusTransitions`), which are a subset of the supervisor points. The first point is always shown.
- **Who may do what** (not specified by the client): only operators log allocations (for themselves); only supervisors adjust. Only an allocation can be adjusted, not an adjustment (adjust the original again instead). The adjustment `reason` is required but is not part of the idempotency comparison.
- **Pool boundary, for writes and reads.** A supervisor can only *adjust* entries in their own pool (`403 TARGET_OTHER_POOL`) and can only *read* operators in their own pool: `GET /api/entries`, `/api/metric` and `/api/operators/:id/timeline` all go through one rule, `requireAccessibleOperator()` in [`src/server/api/access.ts`](./src/server/api/access.ts). Operators can read only themselves. Anything else is `403 FORBIDDEN`, **including an operator id that doesn't exist**: it gets the same answer as an operator at another site, so nobody can probe which ids exist elsewhere. A test fails if a new route skips the rule (see `access-coverage.test.ts`).
- **Over-correction.** An entry's net units (the original plus all its adjustments plus the new one) can't go below zero; exactly zero is allowed. Otherwise `422 ADJUSTMENT_BELOW_ZERO`. This counts every adjustment ever made to the entry (expired or not) and is checked inside the pool lock, so two supervisors adjusting the same entry at once can't both get through.
- **Capacity and adjustments.** Capacity is only checked for units an adjustment would add to the *active* total: a negative adjustment, or one on an already-expired entry, is always allowed, even in a pool that is over capacity.
- **`/api/metric`** is our reading of "metric": the operator's active units and status plus their pool's capacity, active units and lifetime balance. Confirm that is what the client wants to see.

## API

All endpoints return JSON, are never cached (`Cache-Control: no-store`), and take their identity from the session cookie.

### Auth (temporary)

The "session" is a cookie `uid` holding a user id. `POST /api/switch-user` `{ "userId": "…" }` sets it for any existing user, **but only when `ENABLE_USER_SWITCHER=true`** (default off; the endpoint is 404 otherwise) (after `npm run db:seed:demo` try `demo_ada`, `demo_cho`, or the supervisor `demo_sup`). **Anyone can set that cookie to any id, so this identifies users but does not authenticate them.** Everything that needs "who is calling" goes through `requireUser()` in [`src/server/api/auth.ts`](./src/server/api/auth.ts), which is the one place to replace with real login.

### Conventions

- Every `POST` that writes needs an **`Idempotency-Key`** header (any unique string, up to 200 characters). Resend the same key to retry safely: you get the original entry back (`200`, `"replay": true`) and nothing is counted twice.
- The operator / supervisor is the logged-in user, never a body field. `effectiveAt` and `expiresAt` are set by the server; a body that includes them is rejected.
- One shared error handler produces every error response: `{ "error": CODE, "message": … }`.

| Status | When |
| ------ | ---- |
| `400` | Invalid JSON / body / query (`INVALID_REQUEST` lists the fields), or a missing `Idempotency-Key` (`IDEMPOTENCY_KEY_REQUIRED`) |
| `401` | `UNAUTHENTICATED`: no cookie, or it names a user that doesn't exist |
| `403` | `FORBIDDEN` (wrong role, or reading an operator you may not see: another operator, another pool, or an id that doesn't exist) / `NOT_SUPERVISOR` / `TARGET_OTHER_POOL` (a supervisor adjusting an entry outside their own pool) |
| `404` | `TARGET_NOT_FOUND` (an adjustment's target entry), `SUPERVISOR_NOT_FOUND`, `OPERATOR_NOT_FOUND` |
| `409` | `IDEMPOTENCY_KEY_REUSED`: that key was used with a different request (compared: operator, kind, units, refSeq) |
| `422` | `CAPACITY_EXCEEDED`, `TARGET_NOT_ALLOCATION`, `ADJUSTMENT_BELOW_ZERO` (the entry's net units would go below zero) |
| `503` | `BUSY` with `Retry-After: 1`: the pool lock (3 s) or the whole transaction (5 s) timed out. Nothing was written; **retry with the same key** |
| `500` | `INTERNAL`: a fixed message only. The real error is logged on the server, never sent to the client |

### Endpoints

| Endpoint | Who | What |
| -------- | --- | ---- |
| `POST /api/entries` `{ units }` | operators | Log an allocation for yourself. `201` created, `200` replay. The response is `{ replay, entry, metric }`: `metric` is your metric **after** this write, which the screen uses to replace its optimistic guess. |
| `POST /api/adjustments` `{ targetSeq, units, reason }` | supervisors | Adjust an earlier allocation in your own pool (signed, non-zero units; `reason` required; the entry can't drop below zero in total). The adjustment is dated at the target's `effectiveAt` and expires with it. `201` / `200`. The response also carries `metric` for the adjusted operator. |
| `GET /api/entries?cursor=&limit=&operatorId=` | everyone | Newest first, paged by `seq`. Response `{ entries, nextCursor }`; pass `nextCursor` back as `cursor`; `null` = last page. `limit` is 1–100 (default 20). Operators see their own entries, supervisors their own pool (or one operator in it with `operatorId`). |
| `GET /api/metric?operatorId=` | everyone | `{ asOf, operator: { activeUnits, status }, nextExpiryAt, pool: { capacity, activeUnits, lifetimeBalance } }`. `nextExpiryAt` is when the operator's active units next drop because an entry expires (or `null`). Supervisors may pass `operatorId` for an operator in their own pool. |
| `GET /api/operators/:id/timeline?view=` | operators (own), supervisors (own pool) | `{ points: [{ at, balance, status }] }`. `view=transitions` = only where the status changes (the operator default); `view=full` = every balance change (the supervisor default, 403 for operators). |
| `POST /api/switch-user` `{ userId }` | anyone | Temporary login, see above. 404 unless `ENABLE_USER_SWITCHER=true`. |

How the writes stay correct under simultaneous requests: see `allocate()` in [`src/server/allocate.ts`](./src/server/allocate.ts) and `adjust()` in [`src/server/adjust.ts`](./src/server/adjust.ts). In short, one READ COMMITTED transaction locks the pool row, then checks the idempotency key (after the lock, so it sees the previous holder's commit, and before the capacity check, so a replay is never refused for lack of space), then checks capacity, then inserts and increments the balance. The unique index on `(created_by_id, idempotency_key)` is the backstop.

## Trade-offs

- **Polling is paused while the user's own write is in flight.** That avoids counting a write twice (a poll that lands between the server's commit and its answer already includes it), but it also means the screen doesn't refresh for those few moments. The proper fix is to reconcile by `seq`: ignore any server data older than the last confirmed write. That also fits the SSE upgrade later, where pushed events carry a `seq` too.

## Next steps

- **Low-privilege app role (production).** The append-only trigger on `ledger_entry` guards against code mistakes, but a superuser or the table owner can still disable it. Create a separate app role that is granted only `SELECT` and `INSERT` on `ledger_entry` (with `UPDATE` on `pool`, where the cached balance lives), and revoke `UPDATE`, `DELETE`, `TRUNCATE` and `TRIGGER` on the ledger from it. The app should connect as that role, not as the owner. How roles are provisioned depends on the client's environment, so this is not done yet.
