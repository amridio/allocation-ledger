/*
 * The activity log exists in up to three scopes, each cached as its own list:
 *   self      an operator's own entries
 *   operator  a supervisor looking at ONE operator (the default once an operator is selected)
 *   pool      a supervisor looking at everyone in the pool
 */
export type EntriesScope = "self" | "operator" | "pool";

/** The cache key of the list for a scope. The operator-scoped list is per operator. */
export function entriesKeyFor(scope: EntriesScope, subjectId: string): string {
  return scope === "operator" ? `op:${subjectId}` : scope;
}

/** Every cached list a new entry belongs in: the pool's, its operator's, and an operator's own. Never another operator's. */
export function scopeKeysFor(entry: { operatorId: string }): string[] {
  return ["pool", entriesKeyFor("operator", entry.operatorId), "self"];
}

/** The screen's URL. The operator picker and the "everyone" toggle each keep the other's choice. */
export function dashboardHref({ operatorId, logAll }: { operatorId: string; logAll: boolean }): string {
  return `/?operator=${encodeURIComponent(operatorId)}${logAll ? "&log=all" : ""}`;
}
