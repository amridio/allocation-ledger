// Seed script (plain Node + pg; imports the pure domain expiry function directly).
//
//   npm run db:seed        reference data: tiers T1/T2/T3
//   npm run db:seed:demo   reference data + demo operators and ~20 past entries
//
// Tier expiry is the same in both modes. DEFAULTS: TO CONFIRM WITH CLIENT.
//   T1 24 hours, T2 72 hours, T3 never
//   SEED_SHORT_EXPIRY=true: T1 = 2 minutes instead (so expiry can be watched while testing)
//
// Safe to run repeatedly:
//   - tiers and operators are upserted by fixed id / name
//   - ledger entries use fixed idempotency keys with ON CONFLICT DO NOTHING
//     (the ledger is append-only, so existing rows are never touched)
//   - the pool's cached balance is increased only by rows actually inserted, in the
//     same transaction, under a row lock (same rules as the app)
//
// Because expires_at is fixed when an entry is created, SEED_SHORT_EXPIRY only affects demo
// entries inserted on that run. Entries seeded earlier keep the expiry they were created with.
// Re-running a seed overwrites expiry for T1-T3, so never run it against production data.
import pg from "pg";
import { computeExpiresAt } from "../src/domain/expiry.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const demo = process.argv.includes("--demo");
const shortExpiry = process.env.SEED_SHORT_EXPIRY === "true";
if ((demo || shortExpiry) && process.env.NODE_ENV === "production") {
  console.error("Refusing to run the demo / short-expiry seed with NODE_ENV=production");
  process.exit(1);
}

const now = new Date(); // seed script, not domain code: this is where "now" is injected
const minutesAgo = (m) => new Date(now.getTime() - m * 60_000);

const tiers = [
  { id: "tier_t1", name: "T1", expiryMinutes: shortExpiry ? 2 : 24 * 60 },
  { id: "tier_t2", name: "T2", expiryMinutes: 72 * 60 },
  { id: "tier_t3", name: "T3", expiryMinutes: null },
];

// ---- demo data -------------------------------------------------------------------------
const people = [
  { id: "demo_ada", name: "Ada Okafor", role: "OPERATOR", tierId: "tier_t1" },
  { id: "demo_ben", name: "Ben Lindqvist", role: "OPERATOR", tierId: "tier_t1" },
  { id: "demo_cho", name: "Chidi Mensah", role: "OPERATOR", tierId: "tier_t2" },
  { id: "demo_dee", name: "Dee Navarro", role: "OPERATOR", tierId: "tier_t3" },
  { id: "demo_sup", name: "Eli Park (supervisor)", role: "SUPERVISOR", tierId: "tier_t3" },
];

// [key, operator, minutes ago it happened in the field, units]. Created by the operator.
// Ages are chosen so some entries are already expired under the DEFAULT tiers
// (T1 24 h = 1440 min, T2 72 h = 4320 min, T3 never):
//   ada/ben: the entries older than 24 h are expired, the rest are active
//   cho:     the two older than 72 h are expired, the rest are active
//   dee:     never expires
// With SEED_SHORT_EXPIRY=true (T1 = 2 min) all of ada's and ben's entries but the newest expire.
const allocations = [
  ["demo-a01", "demo_ada", 4200, 30],
  ["demo-a02", "demo_ada", 2000, 25],
  ["demo-a03", "demo_ada", 800, 40],
  ["demo-a04", "demo_ada", 90, 15],
  ["demo-a05", "demo_ada", 1, 20],
  ["demo-a06", "demo_ben", 2800, 50],
  ["demo-a07", "demo_ben", 600, 35],
  ["demo-a08", "demo_ben", 45, 25],
  ["demo-a09", "demo_ben", 0.5, 30],
  ["demo-a10", "demo_cho", 6000, 60],
  ["demo-a11", "demo_cho", 4800, 45],
  ["demo-a12", "demo_cho", 3000, 30],
  ["demo-a13", "demo_cho", 1200, 25],
  ["demo-a14", "demo_cho", 20, 40],
  ["demo-a15", "demo_dee", 4300, 55],
  ["demo-a16", "demo_dee", 1000, 20],
  ["demo-a17", "demo_dee", 120, 35],
];

// Supervisor adjustments: [key, key of entry adjusted, minutes ago, signed units, reason].
const adjustments = [
  ["demo-j01", "demo-a12", 600, -5, "Miscount at pickup"],
  ["demo-j02", "demo-a16", 300, 10, "Second crate was not logged"],
  ["demo-j03", "demo-a05", 0.25, -5, "Entered 20, actual was 15"],
];

const SUPERVISOR = "demo_sup";
const POOL = "main";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");

  // Same rule as the app: lock the pool row before inserting ledger rows / touching balance.
  const pool = await client.query(`SELECT id FROM pool WHERE name = $1 FOR UPDATE`, [POOL]);
  if (pool.rowCount === 0) throw new Error(`Pool "${POOL}" not found; run migrations first`);
  const poolId = pool.rows[0].id;

  for (const t of tiers) {
    await client.query(
      `INSERT INTO tier (id, name, expiry_minutes) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET expiry_minutes = EXCLUDED.expiry_minutes`,
      [t.id, t.name, t.expiryMinutes],
    );
  }
  console.log(
    `Tiers (${shortExpiry ? "SHORT expiry: T1 = 2 min" : "defaults"}):`,
    tiers.map((t) => `${t.name}=${t.expiryMinutes ?? "never"}`).join(", "),
  );

  if (demo) {
    // pool_id is deliberately not updated on conflict: ledger rows pin an operator to its pool.
    for (const p of people) {
      await client.query(
        `INSERT INTO operator (id, name, role, tier_id, pool_id) VALUES ($1, $2, $3::"Role", $4, $5)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, tier_id = EXCLUDED.tier_id`,
        [p.id, p.name, p.role, p.tierId, poolId],
      );
    }

    // Expiry comes from the operator's tier as stored in the database right now.
    const expiryByOperator = new Map(
      (
        await client.query(
          `SELECT o.id, t.expiry_minutes FROM operator o JOIN tier t ON t.id = o.tier_id WHERE o.id = ANY($1)`,
          [people.map((p) => p.id)],
        )
      ).rows.map((r) => [r.id, r.expiry_minutes]),
    );

    const insertSql = `
      INSERT INTO ledger_entry
        (kind, operator_id, pool_id, created_by_id, units, effective_at, expires_at, ref_seq, reason, idempotency_key)
      VALUES ($1::"EntryKind", $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (created_by_id, idempotency_key) DO NOTHING
      RETURNING seq, units`;

    let inserted = 0;
    let insertedUnits = 0;
    const record = (res) => {
      inserted += res.rowCount;
      for (const r of res.rows) insertedUnits += r.units;
    };
    const expiryOfEntry = new Map(); // key -> expires_at, for adjustments

    for (const [key, operatorId, ago, units] of allocations) {
      const effectiveAt = minutesAgo(ago);
      const expiresAt = computeExpiresAt(effectiveAt, expiryByOperator.get(operatorId));
      expiryOfEntry.set(key, expiresAt);
      record(
        await client.query(insertSql, [
          "ALLOCATION", operatorId, poolId, operatorId, units, effectiveAt, expiresAt, null, null, key,
        ]),
      );
    }

    for (const [key, refKey, ago, units, reason] of adjustments) {
      const target = (
        await client.query(
          `SELECT seq, operator_id FROM ledger_entry WHERE idempotency_key = $1 AND created_by_id = operator_id`,
          [refKey],
        )
      ).rows[0];
      if (!target) throw new Error(`Adjustment ${key} references missing entry ${refKey}`);
      // ASSUMPTION (TO CONFIRM WITH CLIENT): an adjustment expires together with the entry it adjusts.
      record(
        await client.query(insertSql, [
          "ADJUSTMENT", target.operator_id, poolId, SUPERVISOR, units, minutesAgo(ago),
          expiryOfEntry.get(refKey) ?? null, target.seq, reason, key,
        ]),
      );
    }

    if (insertedUnits !== 0) {
      await client.query(`UPDATE pool SET balance = balance + $1, updated_at = now() WHERE id = $2`, [
        insertedUnits,
        poolId,
      ]);
    }
    console.log(
      `Demo: ${people.length} people upserted; ${inserted} new ledger entries ` +
        `(${allocations.length + adjustments.length - inserted} already present), balance +${insertedUnits}`,
    );
  }

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}
