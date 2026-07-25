import {
  eventQuerySchema,
  ticketSalesQuerySchema,
  scanQuerySchema,
  analyticsQuerySchema,
} from '@validators/tickets.validator';

// Regression coverage for a bug where `endDate: Joi.date().min(Joi.ref('startDate'))`
// was applied unconditionally: sending endDate WITHOUT startDate made Joi try to
// resolve a ref to a field that isn't present, throwing "endDate references
// ref:startDate which must have a valid date format" -> 400. This broke any
// vendor/admin "past" listing that only sends endDate. The fix wraps the
// cross-field `.min(ref)` in a `.when('startDate', { is: Joi.exist(), ... })`
// so the min constraint only kicks in when startDate is also present.
describe.each([
  ['eventQuerySchema', eventQuerySchema],
  ['ticketSalesQuerySchema', ticketSalesQuerySchema],
  ['scanQuerySchema', scanQuerySchema],
  ['analyticsQuerySchema', analyticsQuerySchema],
])('%s endDate/startDate validation', (_name, schema) => {
  it('accepts an endDate without a startDate', () => {
    const { error } = schema.validate({ endDate: '2026-08-01' });
    expect(error).toBeUndefined();
  });

  it('still rejects endDate < startDate when both present', () => {
    const { error } = schema.validate({
      startDate: '2026-08-10',
      endDate: '2026-08-01',
    });
    expect(error).toBeDefined();
  });

  it('still accepts endDate >= startDate when both present', () => {
    const { error } = schema.validate({
      startDate: '2026-08-01',
      endDate: '2026-08-10',
    });
    expect(error).toBeUndefined();
  });
});
