/**
 * Eswatini local timezone — UTC+2, no DST. The API runs in UTC (Cloud Run), so
 * any event time formatted with a plain `Date`/`toLocaleString` on the server
 * renders in UTC and reads 2 hours off. Event times MUST be formatted with this
 * zone so buyers see the real local start time.
 */
export const EVENT_TIMEZONE = 'Africa/Mbabane';

/**
 * Format an event's date/time for humans, in Eswatini local time.
 *
 * Prefers `startTime` — the authoritative stored instant. Falls back to
 * `eventDate` (a DATE-ONLY marker stored as midnight UTC) only when there is no
 * startTime, where the date is still right even if the clock time is nominal.
 * Never format a clock time off `eventDate` directly: midnight UTC renders as
 * "02:00" in Eswatini, which was the long-standing bug.
 */
export function formatEventDateTime(
  startTime: Date | string | null | undefined,
  eventDate: Date | string | null | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  const value = startTime ?? eventDate;
  if (!value) return '';
  return new Date(value).toLocaleString('en-GB', { timeZone: EVENT_TIMEZONE, ...options });
}

/**
 * Midnight at the start of `now`'s day in Africa/Mbabane, as an instant.
 * Eswatini is UTC+2 all year (no DST), so the offset is fixed.
 */
export function startOfLocalDay(now: Date): Date {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: EVENT_TIMEZONE }); // YYYY-MM-DD
  return new Date(`${ymd}T00:00:00+02:00`);
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A venue report's `?from=&to=` window: ISO instants, half-open [from, to).
 * Default: today in Africa/Mbabane; `to` defaults to a day after `from`.
 * Anything that is not text (an array / object query value) is refused, never
 * stringified.
 */
export function parseDayRange(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } | { error: string } {
  const read = (v: unknown): Date | undefined | null => (v === undefined ? undefined : typeof v === 'string' ? new Date(v) : null);
  const [f, t] = [read(fromRaw), read(toRaw)];
  if (f === null || t === null) return { error: 'from and to must be ISO dates' };
  const from = f ?? startOfLocalDay(new Date());
  const to = t ?? new Date(from.getTime() + DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: 'from and to must be ISO dates' };
  if (from.getTime() >= to.getTime()) return { error: 'from must be before to' };
  return { from, to };
}
