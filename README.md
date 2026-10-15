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

Checks: `npm run typecheck`, `npm run lint`, `npm test`.

### Seeding

```bash
npm run db:seed        # reference data only: tiers T1/T2/T3 with the client defaults below
npm run db:seed:demo   # reference data + demo people and 20 past ledger entries
```

`db:seed:demo` adds 4 operators, 1 supervisor, and 17 allocations plus 3 supervisor adjustments in the `main` pool. For testing it also sets the tiers to **T1 = 2 minutes, T2 = 24 hours, T3 = never**, so you can watch expiry happen. Some entries are already expired when it runs. The newest T1 entries expire about a minute or two after seeding.

Both seeds are safe to run repeatedly. Tiers and people are upserted, ledger entries use fixed idempotency keys and are skipped if present, and the pool balance only grows by rows actually inserted. Expiry times are fixed when an entry is created, so to see a fresh burst of T1 expiry, add entries through the app or reset the database (`npx prisma migrate reset`, then `npm run db:seed:demo`).

Running either seed overwrites expiry for T1–T3 and is refused for the demo/short modes when `NODE_ENV=production`. Never run a seed against production data. `SEED_SHORT_EXPIRY=true npm run db:seed` is a lighter option: defaults, but T1 = 2 minutes.

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

**Also to confirm with the client:**
- Expiry is counted from `effective_at` (when it happened in the field), not from when the server recorded it.
- A supervisor adjustment expires together with the entry it adjusts (the seed assumes this; the app rule is not written yet).
