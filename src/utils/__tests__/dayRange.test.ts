import { parseDayRange } from '@utils/eventTime.util';

describe('parseDayRange', () => {
  it('takes two ISO instants', () => {
    expect(parseDayRange('2026-10-01T00:00:00+02:00', '2026-10-02T00:00:00+02:00')).toEqual({
      from: new Date('2026-09-30T22:00:00.000Z'), to: new Date('2026-10-01T22:00:00.000Z'),
    });
  });
  it('defaults to today in Eswatini, and `to` to a day after `from`', () => {
    const today = parseDayRange(undefined, undefined) as { from: Date; to: Date };
    expect(today.to.getTime() - today.from.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(today.from.toISOString().endsWith('T22:00:00.000Z')).toBe(true);
    const fromOnly = parseDayRange('2026-10-01T00:00:00+02:00', undefined) as { from: Date; to: Date };
    expect(fromOnly.to).toEqual(new Date('2026-10-01T22:00:00.000Z'));
  });
  it('refuses a non-date, a non-string and a backwards range', () => {
    expect(parseDayRange('yesterday', undefined)).toEqual({ error: 'from and to must be ISO dates' });
    expect(parseDayRange({ toString: 'x' }, undefined)).toEqual({ error: 'from and to must be ISO dates' });
    expect(parseDayRange(['a', 'b'], undefined)).toEqual({ error: 'from and to must be ISO dates' });
    expect(parseDayRange('2026-10-02T00:00:00+02:00', '2026-10-01T00:00:00+02:00')).toEqual({ error: 'from must be before to' });
  });
});
