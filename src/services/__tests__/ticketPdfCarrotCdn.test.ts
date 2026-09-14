/**
 * Ticket PDFs must be stored on the CARROT bucket and handed out under
 * cdn.carrottickets.com. They used to go to the legacy `keshless-tickets`
 * bucket, so the link in every ticket SMS and email read
 * "keshless-tickets-media.omevision.com" — the customer's first impression of
 * a product that is no longer called Keshless.
 */
import { TicketPdfStatus } from '@interfaces/ticket.interface';

const putBuffer = jest.fn().mockResolvedValue(undefined);
const publicUrl = jest.fn((key: string): string => `https://cdn.carrottickets.com/${key}`);

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    putBuffer: (key: string, buffer: Buffer, contentType: string) => putBuffer(key, buffer, contentType),
    publicUrl: (key: string) => publicUrl(key),
  },
}));

// The legacy client must not be reached at all for ticket PDFs.
const legacyUploadFile = jest.fn();
jest.mock('@utils/r2.service', () => ({
  R2Service: { uploadFile: (a: string, b: string, c: Buffer, d: string) => legacyUploadFile(a, b, c, d) },
}));

import { TicketPdfService } from '@services/ticketPdf.service';

function ticket(overrides: Record<string, any> = {}) {
  return {
    ticketId: 'TKT-CDN-001',
    ticketType: 'VIP',
    price: 150,
    status: 'sold',
    customerName: 'Jane Doe',
    eventId: {
      _id: 'evt123',
      name: 'Test Event',
      venue: 'Test Venue',
      eventDate: new Date('2026-12-01'),
      startTime: new Date('2026-12-01T18:00:00Z'),
      endTime: new Date('2026-12-01T22:00:00Z'),
    },
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

beforeEach(() => {
  putBuffer.mockClear();
  publicUrl.mockClear();
  legacyUploadFile.mockClear();
});

it('stores the ticket PDF on the Carrot bucket and returns a cdn.carrottickets.com url', async () => {
  const t = ticket();

  const res = await TicketPdfService.ensureTicketPdf(t);

  expect(res.status).toBe(TicketPdfStatus.READY);
  expect(res.pdfUrl).toMatch(/^https:\/\/cdn\.carrottickets\.com\//);
  expect(res.pdfUrl).not.toMatch(/keshless/i);
  expect(t.pdfUrl).toBe(res.pdfUrl);

  // The bytes actually went to the Carrot bucket, as a PDF.
  expect(putBuffer).toHaveBeenCalledTimes(1);
  const [key, buffer, contentType] = putBuffer.mock.calls[0]!;
  expect(key).toBe('tickets/evt123/TKT-CDN-001.pdf');
  expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  expect(contentType).toBe('application/pdf');

  // And the legacy Keshless bucket was not touched.
  expect(legacyUploadFile).not.toHaveBeenCalled();
});

it('marks the ticket FAILED and throws when the Carrot upload fails — never a stale url', async () => {
  putBuffer.mockRejectedValueOnce(new Error('R2 down'));
  const t = ticket({ ticketId: 'TKT-CDN-002' });

  await expect(TicketPdfService.ensureTicketPdf(t)).rejects.toThrow(/R2 down|Failed to generate/i);
  expect(t.pdfStatus).toBe(TicketPdfStatus.FAILED);
  expect(t.pdfUrl).toBeUndefined();
});
