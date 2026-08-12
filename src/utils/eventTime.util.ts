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
