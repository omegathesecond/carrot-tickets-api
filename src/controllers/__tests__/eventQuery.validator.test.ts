import { publicEventsQuerySchema } from '@controllers/public.controller';

describe('publicEventsQuerySchema (public events query validation)', () => {
  it('accepts an endDate without a startDate (Past tab)', () => {
    const { error } = publicEventsQuerySchema.validate({ endDate: new Date().toISOString() });
    expect(error).toBeUndefined();
  });

  it('still rejects endDate < startDate when both present', () => {
    const { error } = publicEventsQuerySchema.validate({
      startDate: '2026-08-10',
      endDate: '2026-08-01',
    });
    expect(error).toBeDefined();
  });

  it('still accepts endDate >= startDate when both present', () => {
    const { error } = publicEventsQuerySchema.validate({
      startDate: '2026-08-01',
      endDate: '2026-08-10',
    });
    expect(error).toBeUndefined();
  });
});
