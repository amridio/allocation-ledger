# Allocation Ledger

Field operations module. Operators log resource allocations from their phones; allocations add to a shared unit pool; each operator's running total sets a status level. Project rules are in [`CLAUDE.md`](./CLAUDE.md).

Stack: Next.js (App Router), TypeScript, Prisma 7 + Postgres 16, TanStack Query, Tailwind, Zod, Vitest.

## Local setup

```bash
cp .env.example .env
docker compose up -d --wait      # Postgres 16 (dev + test databases)
npm install                      # also runs `prisma generate`
npm run db:migrate               # apply migrations
npm run db:seed                  # seed tiers
npm run dev
```

Checks: `npm run typecheck`, `npm run lint`, `npm test`.

### Watching expiry locally

```bash
SEED_SHORT_EXPIRY=true npm run db:seed   # T1 expires after 2 minutes instead of 24 hours
npm run db:seed                          # back to the defaults
```

`SEED_SHORT_EXPIRY=true` is refused when `NODE_ENV=production`. Re-running the seed overwrites expiry for T1–T3, so don't run it against production data.

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

An entry's `expires_at` is calculated once, when it is created, from the operator's tier at that time. Changing a tier's expiry later does not alter existing entries.
