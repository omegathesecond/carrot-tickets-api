import { formatEventDateTime } from '@utils/eventTime.util';

/**
 * Event times must render in Eswatini local time (UTC+2) regardless of the
 * server's timezone (Cloud Run is UTC). A startTime of 07:00Z is a 09:00 local
 * start — the bug was showing it 2 hours off (or "02:00" off midnight-UTC
 * eventDate).
 */
describe('formatEventDateTime — Eswatini local time', () => {
  const TIME_OPTS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };

  it('renders a 07:00Z start as 09:00 local (UTC+2)', () => {
    expect(formatEventDateTime('2026-08-15T07:00:00.000Z', '2026-08-15T00:00:00.000Z', TIME_OPTS)).toBe('09:00');
  });

  it('prefers startTime over the midnight-UTC eventDate marker', () => {
    // eventDate alone (midnight UTC) would render as 02:00 local — the old bug.
    expect(formatEventDateTime('2026-08-15T11:30:00.000Z', '2026-08-15T00:00:00.000Z', TIME_OPTS)).toBe('13:30');
  });

  it('falls back to eventDate when there is no startTime', () => {
    // Date stays right; the nominal clock time is the only casualty.
    const out = formatEventDateTime(undefined, '2026-08-15T00:00:00.000Z', { day: '2-digit', month: 'short' });
    expect(out).toContain('Aug');
  });

  it('returns empty string when neither is present', () => {
    expect(formatEventDateTime(null, null, TIME_OPTS)).toBe('');
  });
});
