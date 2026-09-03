import { TicketPdfService } from '@services/ticketPdf.service';

function ticket(overrides: Record<string, any> = {}) {
  return {
    ticketId: 'TKT-TEST-001',
    ticketType: 'VIP',
    price: 150,
    status: 'sold',
    customerName: 'Jane Doe',
    customerPhone: '+26876543210',
    eventId: {
      name: 'Test Event',
      venue: 'Test Venue',
      eventDate: new Date('2026-12-01'),
      startTime: new Date('2026-12-01T18:00:00Z'),
      endTime: new Date('2026-12-01T22:00:00Z'),
    },
    ...overrides,
  } as any;
}

describe('TicketPdfService', () => {
  it('renders a valid PDF for a ticket with a populated event', async () => {
    const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders a valid PDF when the ticket has no populated event', async () => {
    const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket({ eventId: undefined }));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders a valid PDF when the ticket has no price or customer name', async () => {
    const buffer = await TicketPdfService.buildTicketPdfBuffer(
      ticket({ price: undefined, customerName: undefined }),
    );
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('bundles multiple tickets into one multi-page PDF', async () => {
    const buffer = await TicketPdfService.buildBundlePdfBuffer([ticket(), ticket({ ticketId: 'TKT-TEST-002' })]);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects an empty bundle', async () => {
    await expect(TicketPdfService.buildBundlePdfBuffer([])).rejects.toThrow('No tickets to bundle');
  });
});
