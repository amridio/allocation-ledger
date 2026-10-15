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

Integration tests run against real Postgres (`TEST_DATABASE_URL`, migrated automatically): `npm run test:int`. The ledger is append-only, so these tests can't clean up after themselves. Each test creates its own pool, tier and operator, and the test database just grows. To reset it: `docker compose down -v && docker compose up -d --wait`.

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
- **Who may do what** (not specified by the client): only operators log allocations (for themselves); only supervisors adjust; a supervisor may adjust an entry in any pool and sees their own pool's entries by default. Only an allocation can be adjusted, not an adjustment (adjust the original again instead). The adjustment `reason` is required but is not part of the idempotency comparison.
- **Capacity and adjustments.** Capacity is only checked for units an adjustment would add to the *active* total: a negative adjustment, or one on an already-expired entry, is always allowed, even in a pool that is over capacity.
- **`/api/metric`** is our reading of "metric": the operator's active units and status plus their pool's capacity, active units and lifetime balance. Confirm that is what the client wants to see.

## API

All endpoints return JSON, are never cached (`Cache-Control: no-store`), and take their identity from the session cookie.

### Auth (temporary)

The "session" is a cookie `uid` holding a user id. `POST /api/switch-user` `{ "userId": "…" }` sets it for any existing user (after `npm run db:seed:demo` try `demo_ada`, `demo_cho`, or the supervisor `demo_sup`). **Anyone can set that cookie to any id, so this identifies users but does not authenticate them.** Everything that needs "who is calling" goes through `requireUser()` in [`src/server/api/auth.ts`](./src/server/api/auth.ts), which is the one place to replace with real login.

### Conventions

- Every `POST` that writes needs an **`Idempotency-Key`** header (any unique string, up to 200 characters). Resend the same key to retry safely: you get the original entry back (`200`, `"replay": true`) and nothing is counted twice.
- The operator / supervisor is the logged-in user, never a body field. `effectiveAt` and `expiresAt` are set by the server; a body that includes them is rejected.
- One shared error handler produces every error response: `{ "error": CODE, "message": … }`.

| Status | When |
| ------ | ---- |
| `400` | Invalid JSON / body / query (`INVALID_REQUEST` lists the fields), or a missing `Idempotency-Key` (`IDEMPOTENCY_KEY_REQUIRED`) |
| `401` | `UNAUTHENTICATED`: no cookie, or it names a user that doesn't exist |
| `403` | `FORBIDDEN` (wrong role, or an operator asking about someone else) / `NOT_SUPERVISOR` |
| `404` | `NOT_FOUND`, `OPERATOR_NOT_FOUND`, `TARGET_NOT_FOUND` |
| `409` | `IDEMPOTENCY_KEY_REUSED`: that key was used with a different request (compared: operator, kind, units, refSeq) |
| `422` | `CAPACITY_EXCEEDED`, `TARGET_NOT_ALLOCATION` |
| `503` | `BUSY` with `Retry-After: 1`: the pool lock (3 s) or the whole transaction (5 s) timed out. Nothing was written; **retry with the same key** |
| `500` | `INTERNAL`: a fixed message only. The real error is logged on the server, never sent to the client |

### Endpoints

| Endpoint | Who | What |
| -------- | --- | ---- |
| `POST /api/entries` `{ units }` | operators | Log an allocation for yourself. `201` created, `200` replay. |
| `POST /api/adjustments` `{ targetSeq, units, reason }` | supervisors | Adjust an earlier allocation (signed, non-zero units; `reason` required). The adjustment is dated at the target's `effectiveAt` and expires with it. `201` / `200`. |
| `GET /api/entries?cursor=&limit=&operatorId=` | everyone | Newest first, paged by `seq`. Response `{ entries, nextCursor }`; pass `nextCursor` back as `cursor`; `null` = last page. `limit` is 1–100 (default 20). Operators see their own entries, supervisors their whole pool (or one operator with `operatorId`). |
| `GET /api/metric?operatorId=` | everyone | `{ asOf, operator: { activeUnits, status }, pool: { capacity, activeUnits, lifetimeBalance } }`. Supervisors may pass `operatorId`. |
| `GET /api/operators/:id/timeline?view=` | operators (own), supervisors (any) | `{ points: [{ at, balance, status }] }`. `view=transitions` = only where the status changes (the operator default); `view=full` = every balance change (the supervisor default, 403 for operators). |
| `POST /api/switch-user` `{ userId }` | anyone | Temporary login, see above. |

How the writes stay correct under simultaneous requests: see `allocate()` in [`src/server/allocate.ts`](./src/server/allocate.ts) and `adjust()` in [`src/server/adjust.ts`](./src/server/adjust.ts). In short, one READ COMMITTED transaction locks the pool row, then checks the idempotency key (after the lock, so it sees the previous holder's commit, and before the capacity check, so a replay is never refused for lack of space), then checks capacity, then inserts and increments the balance. The unique index on `(created_by_id, idempotency_key)` is the backstop.

## Next steps

- **Low-privilege app role (production).** The append-only trigger on `ledger_entry` guards against code mistakes, but a superuser or the table owner can still disable it. Create a separate app role that is granted only `SELECT` and `INSERT` on `ledger_entry` (with `UPDATE` on `pool`, where the cached balance lives), and revoke `UPDATE`, `DELETE`, `TRUNCATE` and `TRIGGER` on the ledger from it. The app should connect as that role, not as the owner. How roles are provisioned depends on the client's environment, so this is not done yet.
