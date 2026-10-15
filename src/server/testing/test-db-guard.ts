/**
 * Integration tests add rows that can never be deleted (the ledger is append-only), so they must
 * never run against the dev database. Refuses anything that isn't clearly a test database:
 * the URL must parse, must not be the dev DATABASE_URL, and the database name must end in `_test`.
 */
export function assertSafeTestDatabase(testUrl: string | undefined, devUrl: string | undefined): void {
  if (!testUrl) throw new Error("TEST_DATABASE_URL is not set");

  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }

  const where = (url: URL) => `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  if (devUrl) {
    try {
      if (where(new URL(devUrl)) === where(parsed)) {
        throw new Error("TEST_DATABASE_URL points at the same database as DATABASE_URL; integration tests must not touch dev data");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("same database")) throw err;
      // an unparseable DATABASE_URL can't be the same database; the name check below still applies
    }
  }

  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!name.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL must name a database ending in _test (got "${name}"): integration tests add rows that can never be deleted`,
    );
  }
}
