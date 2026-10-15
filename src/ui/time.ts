/**
 * Times are always shown in ONE configured zone (APP_TIMEZONE), never "whatever this device says".
 * The page is rendered on the server and then again in the browser; if each used its own zone the
 * text would change after hydration. `now` is passed in, never read here.
 */

/** A real IANA zone name, or "UTC". */
export function resolveTimeZone(name: string | undefined): string {
  if (!name) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return name;
  } catch {
    return "UTC";
  }
}

const clock = (timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayOf = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const dayLabel = (timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" });

/** "14:03" */
export function formatClock(iso: string | Date, timeZone: string): string {
  return clock(timeZone).format(new Date(iso));
}

/** "14:03" for today, "28 Feb 14:03" for any other day (today = the calendar day of `now` in `timeZone`). */
export function formatWhen(iso: string | Date, now: Date, timeZone: string): string {
  const at = new Date(iso);
  const time = formatClock(at, timeZone);
  if (dayOf(timeZone).format(at) === dayOf(timeZone).format(now)) return time;
  return `${dayLabel(timeZone).format(at)} ${time}`;
}
