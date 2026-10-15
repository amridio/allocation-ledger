/** The pg driver's own default, so leaving DATABASE_POOL_SIZE unset changes nothing. */
export const DEFAULT_POOL_SIZE = 10;

/**
 * DATABASE_POOL_SIZE: the maximum number of Postgres connections ONE app instance may hold.
 * Unset or blank = DEFAULT_POOL_SIZE. Anything that isn't a whole number >= 1 throws instead of
 * silently falling back, because a typo here changes how the app behaves under load. The error fires
 * the first time the database client is created (the first API request, not server boot) and
 * surfaces as a plain 500 whose message appears only in the server log.
 */
export function parsePoolSize(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_POOL_SIZE;
  const text = value.trim();
  const size = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(size)) {
    throw new Error(`DATABASE_POOL_SIZE must be a whole number of at least 1, got "${value}"`);
  }
  return size;
}
