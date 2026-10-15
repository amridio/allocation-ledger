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
- **Adjustments.** A supervisor adjustment is a signed ledger entry that takes effect at its own `effective_at` and expires together with the entry it adjusts (the seed assumes this; the app rule is not written yet). Backdating an adjustment changes the balance and status from that moment on, never before it.
- **Capacity** is measured in active (non-expired) units, not the cached `balance`. An allocation that would exceed it is **rejected** (422); the service assumes rejecting rather than warning, so confirm that with the client. Reaching capacity exactly is allowed.
- **Timeouts.** A pool-lock timeout (3 s) and a whole-transaction timeout (5 s) both return `503` with `Retry-After: 1`; retrying with the same key is always safe.
- **Two history views.** Supervisors see every balance change (`statusTimeline`). Operators see only the points where their status changes (`statusTransitions`), which are a subset of the supervisor points. The first point is always shown.

## API

### `POST /api/allocations`

Logs an allocation for an operator. The server sets `effectiveAt` (now) and `expiresAt` (from the operator's tier); a request that includes either is rejected.

```json
{ "operatorId": "…", "units": 25, "idempotencyKey": "client-generated-unique-string" }
```

| Status | Meaning |
| ------ | ------- |
| `201` | Created. Body: `{ "replay": false, "entry": {…} }` |
| `200` | The same `idempotencyKey` was already used with the same request: the original entry is returned (`"replay": true`) and nothing changes. Safe to resend after a timeout. |
| `409` | `IDEMPOTENCY_KEY_REUSED`: that key was used with a different request. Compared: operator, kind, units, refSeq. |
| `422` | `CAPACITY_EXCEEDED`: the pool's **active** units plus this allocation would exceed its capacity. |
| `404` | `OPERATOR_NOT_FOUND` |
| `400` | Invalid JSON or body. |
| `503` | `BUSY` with `Retry-After: 1`: the pool lock (3 s) or the whole transaction (5 s) timed out. Nothing was written; **retry with the same `idempotencyKey`**. |

There is no authentication yet: `operatorId` is trusted as sent.

How it stays correct under simultaneous requests: see `allocate()` in [`src/server/allocate.ts`](./src/server/allocate.ts). In short, one READ COMMITTED transaction locks the pool row, then checks the idempotency key (after the lock, so it sees the previous holder's commit, and before the capacity check, so a replay is never refused for lack of space), then checks capacity, then inserts and increments the balance. The unique index on `(created_by_id, idempotency_key)` is the backstop.

## Next steps

- **Low-privilege app role (production).** The append-only trigger on `ledger_entry` guards against code mistakes, but a superuser or the table owner can still disable it. Create a separate app role that is granted only `SELECT` and `INSERT` on `ledger_entry` (with `UPDATE` on `pool`, where the cached balance lives), and revoke `UPDATE`, `DELETE`, `TRUNCATE` and `TRIGGER` on the ledger from it. The app should connect as that role, not as the owner. How roles are provisioned depends on the client's environment, so this is not done yet.
