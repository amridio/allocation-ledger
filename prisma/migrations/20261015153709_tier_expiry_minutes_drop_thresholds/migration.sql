-- Tier expiry moves from hours to minutes so short local-test values (e.g. 2 minutes) are expressible.
-- Rename + convert instead of drop/add so any existing values are preserved.
ALTER TABLE "tier" RENAME COLUMN "expiry_hours" TO "expiry_minutes";
UPDATE "tier" SET "expiry_minutes" = "expiry_minutes" * 60 WHERE "expiry_minutes" IS NOT NULL;

-- Status cutoffs now live in code (src/domain/status-config.ts), not the database.
-- The table was never populated.
DROP TABLE "status_threshold";
DROP TYPE "StatusLevel";
