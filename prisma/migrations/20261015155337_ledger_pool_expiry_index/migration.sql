-- CreateIndex
CREATE INDEX "ledger_entry_pool_id_expires_at_idx" ON "ledger_entry"("pool_id", "expires_at");
