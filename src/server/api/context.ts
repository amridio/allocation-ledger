import type { LedgerTxDeps } from "../ledger-tx";

/** What every handler gets: the database and the clock (plus optional timeout overrides for tests). */
export type ApiContext = LedgerTxDeps;
