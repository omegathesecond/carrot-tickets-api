import { startOfLocalDay } from '@utils/eventTime.util';

describe('startOfLocalDay (Africa/Mbabane, UTC+2)', () => {
  it('23:30 local is still that day', () => {
    expect(startOfLocalDay(new Date('2026-10-02T21:30:00Z')).toISOString()).toBe('2026-10-01T22:00:00.000Z');
  });
  it('00:30 local is the next day', () => {
    expect(startOfLocalDay(new Date('2026-10-02T22:30:00Z')).toISOString()).toBe('2026-10-02T22:00:00.000Z');
  });
});
