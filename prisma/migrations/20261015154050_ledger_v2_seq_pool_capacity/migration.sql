-- Ledger v2: autoincrement seq key, effective/recorded timestamps, ADJUSTMENT kind,
-- idempotency key scoped per creator, pool capacity + cached balance, operator belongs to a pool.

-- ledger_entry is rebuilt (primary key changes from id to seq). Refuse to do that over real data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ledger_entry") THEN
    RAISE EXCEPTION 'ledger_entry is not empty; this migration rebuilds it and cannot preserve rows';
  END IF;
END $$;

-- Pool: total_units -> balance (cached sum of ledger units), add capacity (NULL = no limit).
ALTER TABLE "pool" RENAME COLUMN "total_units" TO "balance";
ALTER TABLE "pool" ALTER COLUMN "balance" TYPE INTEGER USING "balance"::INTEGER;
ALTER TABLE "pool" ADD COLUMN "capacity" INTEGER;
ALTER TABLE "pool" ADD CONSTRAINT "pool_capacity_nonneg" CHECK ("capacity" IS NULL OR "capacity" >= 0);

-- Operator: belongs to a pool. Backfill existing rows into the main pool first.
ALTER TABLE "operator" ADD COLUMN "pool_id" TEXT;
UPDATE "operator" SET "pool_id" = (SELECT "id" FROM "pool" WHERE "name" = 'main') WHERE "pool_id" IS NULL;
ALTER TABLE "operator" ALTER COLUMN "pool_id" SET NOT NULL;
ALTER TABLE "operator" ADD CONSTRAINT "operator_pool_id_fkey"
  FOREIGN KEY ("pool_id") REFERENCES "pool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Target of ledger_entry's composite FK (keeps entry.pool_id == operator.pool_id).
CREATE UNIQUE INDEX "operator_id_pool_id_key" ON "operator"("id", "pool_id");

-- Rebuild ledger_entry.
DROP TABLE "ledger_entry";
DROP TYPE "EntryKind";
CREATE TYPE "EntryKind" AS ENUM ('ALLOCATION', 'ADJUSTMENT');

CREATE TABLE "ledger_entry" (
    "seq" SERIAL NOT NULL,
    "kind" "EntryKind" NOT NULL,
    "operator_id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "ref_seq" INTEGER,
    "reason" TEXT,
    "idempotency_key" TEXT NOT NULL,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("seq"),
    CONSTRAINT "ledger_entry_units_nonzero" CHECK ("units" <> 0),
    CONSTRAINT "ledger_entry_allocation_positive" CHECK ("kind" <> 'ALLOCATION' OR "units" > 0),
    -- Allocations reference nothing; adjustments must reference an earlier entry and say why.
    CONSTRAINT "ledger_entry_kind_shape" CHECK (
      ("kind" = 'ALLOCATION' AND "ref_seq" IS NULL)
      OR ("kind" = 'ADJUSTMENT' AND "ref_seq" IS NOT NULL AND "ref_seq" < "seq" AND "reason" IS NOT NULL)
    ),
    CONSTRAINT "ledger_entry_idempotency_key_nonempty" CHECK (length("idempotency_key") > 0)
);

CREATE UNIQUE INDEX "ledger_entry_created_by_id_idempotency_key_key" ON "ledger_entry"("created_by_id", "idempotency_key");
CREATE INDEX "ledger_entry_operator_id_effective_at_seq_idx" ON "ledger_entry"("operator_id", "effective_at", "seq");
CREATE INDEX "ledger_entry_pool_id_seq_idx" ON "ledger_entry"("pool_id", "seq");
CREATE INDEX "ledger_entry_ref_seq_idx" ON "ledger_entry"("ref_seq");

ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_operator_id_pool_id_fkey"
  FOREIGN KEY ("operator_id", "pool_id") REFERENCES "operator"("id", "pool_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_pool_id_fkey"
  FOREIGN KEY ("pool_id") REFERENCES "pool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_ref_seq_fkey"
  FOREIGN KEY ("ref_seq") REFERENCES "ledger_entry"("seq") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: dropping the table removed the triggers; the function ledger_entry_append_only() still exists.
CREATE TRIGGER ledger_entry_no_update_delete
  BEFORE UPDATE OR DELETE ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_append_only();
CREATE TRIGGER ledger_entry_no_truncate
  BEFORE TRUNCATE ON "ledger_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entry_append_only();
