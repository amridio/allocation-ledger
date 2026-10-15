-- The kind formerly called CORRECTION is now ADJUSTMENT; update the error message to match.
CREATE OR REPLACE FUNCTION ledger_entry_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only (% not allowed); insert an ADJUSTMENT row instead', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
