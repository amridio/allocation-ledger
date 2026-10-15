import type { LedgerTxDeps } from "../ledger-tx";

/** What every handler gets: the database and the clock (plus optional timeout overrides for tests). */
export interface ApiContext extends LedgerTxDeps {
  /** TEMPORARY login (POST /api/switch-user). Off unless explicitly true: see ENABLE_USER_SWITCHER. */
  userSwitcherEnabled?: boolean;
}
