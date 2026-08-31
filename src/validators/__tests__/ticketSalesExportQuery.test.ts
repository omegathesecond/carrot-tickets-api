import { ticketSalesExportQuerySchema } from '@validators/tickets.validator';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

const ok = (q: Record<string, unknown>) => ticketSalesExportQuerySchema.validate(q).error === undefined;

describe('ticketSalesExportQuerySchema', () => {
  it('accepts the full filter set the Sales History page can send', () => {
    expect(ok({
      eventId: '507f1f77bcf86cd799439011',
      paymentMethod: PaymentMethod.MTN_MOMO,
      paymentStatus: PaymentStatus.COMPLETED,
      channel: SalesChannel.RESELLER_POS,
      startDate: '2026-08-01',
      endDate: '2026-08-28',
    })).toBe(true);
  });

  it('accepts an empty query — export everything the caller may see', () => {
    expect(ok({})).toBe(true);
  });

  // The point of validating: without it these silently match nothing and the
  // organizer downloads an empty CSV that reads as "no sales".
  it.each([
    ['channel', { channel: 'reseller-pos' }],
    ['paymentMethod', { paymentMethod: 'momo' }],
    ['paymentStatus', { paymentStatus: 'done' }],
    ['eventId', { eventId: 'not-an-objectid' }],
  ])('rejects an invalid %s', (_label, query) => {
    expect(ok(query)).toBe(false);
  });

  it('rejects an end date before the start date', () => {
    expect(ok({ startDate: '2026-08-28', endDate: '2026-08-01' })).toBe(false);
  });

  it('allows an endDate with no startDate', () => {
    // Mirrors ticketSalesQuerySchema: the min() ref must not blow up when
    // startDate is absent.
    expect(ok({ endDate: '2026-08-28' })).toBe(true);
  });

  it('coerces dates so the controller does not re-wrap strings', () => {
    const { value } = ticketSalesExportQuerySchema.validate({ startDate: '2026-08-01' });
    expect(value.startDate).toBeInstanceOf(Date);
  });

  // Paging belongs to the table, not the download. Accepting `limit` here
  // would invite a CSV silently truncated to one page.
  it('rejects paging params', () => {
    expect(ok({ page: 2 })).toBe(false);
    expect(ok({ limit: 25 })).toBe(false);
  });
});
