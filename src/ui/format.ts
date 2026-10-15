const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type ExpiryText = { kind: "none" | "expired" | "active"; text: string };

/**
 * Human wording for an entry's expiry. Same boundary rule as the domain: at the exact expiry
 * instant it is already expired. `now` is passed in, never read here.
 */
export function describeExpiry(expiresAt: string | Date | null, now: Date): ExpiryText {
  if (expiresAt === null) return { kind: "none", text: "No expiry" };
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (left <= 0) return { kind: "expired", text: "Expired" };
  if (left < MIN) return { kind: "active", text: "Expires in under 1 min" };

  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  const minutes = Math.floor((left % HOUR) / MIN);
  const parts =
    days > 0
      ? [`${days} d`, hours > 0 ? `${hours} h` : ""]
      : hours > 0
        ? [`${hours} h`, minutes > 0 ? `${minutes} min` : ""]
        : [`${minutes} min`];
  return { kind: "active", text: `Expires in ${parts.filter(Boolean).join(" ")}` };
}

/** +25, −5 (a real minus sign, easier to see than a hyphen), 0. */
export function formatSigned(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}
