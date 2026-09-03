import { TicketPdfService } from '@services/ticketPdf.service';

// A valid, minimal 1x1 PNG — stands in for a fetched event poster.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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
      posterUrl: 'https://cdn.example.com/poster.png',
    },
    ...overrides,
  } as any;
}

describe('TicketPdfService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('renders a valid PDF when the poster fetch succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
    }) as any;

    const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(global.fetch).toHaveBeenCalledWith('https://cdn.example.com/poster.png');
  });

  it('still renders a valid PDF when the poster fetch fails (never blocks the QR/ticket)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as any;

    const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still renders a valid PDF when the poster is an unsupported/undecodable format (e.g. WebP)', async () => {
    // posterUpload middleware allows image/webp, but PDFKit only decodes
    // JPEG/PNG — this bytes-not-a-real-image buffer stands in for that.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from('RIFF....WEBPVP8 not-a-real-image').buffer,
    }) as any;

    const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still renders a valid PDF when the poster fetch throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as any;

    const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket());
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('renders a valid PDF when the event has no poster at all', async () => {
    global.fetch = jest.fn() as any;

    const buffer = await TicketPdfService.buildTicketPdfBuffer(
      ticket({ eventId: { name: 'No Poster Event', venue: 'Venue', eventDate: new Date() } }),
    );
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders a valid PDF when the ticket has no populated event', async () => {
    const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket({ eventId: undefined }));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('bundles multiple tickets into one multi-page PDF', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as any;

    const buffer = await TicketPdfService.buildBundlePdfBuffer([ticket(), ticket({ ticketId: 'TKT-TEST-002' })]);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects an empty bundle', async () => {
    await expect(TicketPdfService.buildBundlePdfBuffer([])).rejects.toThrow('No tickets to bundle');
  });
});
