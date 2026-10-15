// Seeds the tiers. Plain Node + pg (no TS runner needed). Run: npm run db:seed
//
// DEFAULTS: TO CONFIRM WITH CLIENT.
//   T1 24h, T2 72h, T3 never expires.
// SEED_SHORT_EXPIRY=true seeds T1 with 2 minutes so expiry can be watched locally.
// Re-running overwrites expiry for these three tiers, so don't run it against production data.
import pg from "pg";

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const short = process.env.SEED_SHORT_EXPIRY === "true";
if (short && process.env.NODE_ENV === "production") {
  console.error("Refusing to seed SEED_SHORT_EXPIRY=true with NODE_ENV=production");
  process.exit(1);
}

const tiers = [
  { id: "tier_t1", name: "T1", expiryMinutes: short ? 2 : 24 * 60 },
  { id: "tier_t2", name: "T2", expiryMinutes: 72 * 60 },
  { id: "tier_t3", name: "T3", expiryMinutes: null },
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  for (const t of tiers) {
    await client.query(
      `INSERT INTO tier (id, name, expiry_minutes) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET expiry_minutes = EXCLUDED.expiry_minutes`,
      [t.id, t.name, t.expiryMinutes],
    );
  }
  console.log(
    `Seeded tiers (${short ? "SHORT expiry: T1 = 2 min" : "defaults"}):`,
    tiers.map((t) => `${t.name}=${t.expiryMinutes ?? "never"}`).join(", "),
  );
} finally {
  await client.end();
}
