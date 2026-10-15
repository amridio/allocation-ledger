-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OPERATOR', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "StatusLevel" AS ENUM ('CRITICAL', 'LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "EntryKind" AS ENUM ('ALLOCATION', 'CORRECTION');

-- CreateTable
CREATE TABLE "tier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "expiry_hours" INTEGER,

    CONSTRAINT "tier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_threshold" (
    "level" "StatusLevel" NOT NULL,
    "min_units" INTEGER NOT NULL,

    CONSTRAINT "status_threshold_pkey" PRIMARY KEY ("level")
);

-- CreateTable
CREATE TABLE "operator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "tier_id" TEXT NOT NULL,

    CONSTRAINT "operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "total_units" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entry" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "kind" "EntryKind" NOT NULL,
    "operator_id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "corrects_id" TEXT,
    "reason" TEXT,
    "created_by_id" TEXT NOT NULL,

    CONSTRAINT "ledger_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tier_name_key" ON "tier"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pool_name_key" ON "pool"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entry_idempotency_key_key" ON "ledger_entry"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entry_operator_id_occurred_at_id_idx" ON "ledger_entry"("operator_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "ledger_entry_corrects_id_idx" ON "ledger_entry"("corrects_id");

-- AddForeignKey
ALTER TABLE "operator" ADD CONSTRAINT "operator_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "tier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_corrects_id_fkey" FOREIGN KEY ("corrects_id") REFERENCES "ledger_entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Ledger is append-only: reject UPDATE, DELETE and TRUNCATE at the database.
-- Corrections are new rows (kind = 'CORRECTION').
-- ---------------------------------------------------------------------------
CREATE FUNCTION ledger_entry_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only (% not allowed); insert a CORRECTION row instead', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_no_update_delete
  BEFORE UPDATE OR DELETE ON "ledger_entry"
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_append_only();

CREATE TRIGGER ledger_entry_no_truncate
  BEFORE TRUNCATE ON "ledger_entry"
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_entry_append_only();

-- The single shared unit pool. Locked with SELECT ... FOR UPDATE on every write.
INSERT INTO "pool" ("id", "name", "total_units", "updated_at")
VALUES ('pool_main', 'main', 0, CURRENT_TIMESTAMP);
