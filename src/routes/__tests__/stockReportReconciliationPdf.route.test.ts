// src/routes/__tests__/stockReportReconciliationPdf.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { extractPdfText } from '@/__tests__/helpers/pdfText';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 560000;

async function ownedCashlessEvent() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  // Named here rather than through the shared fixture: the filename and header
  // assertions need a known name, and widening SeedPublishedEventOptions for
  // one suite would touch every caller.
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true, name: 'Ocean Summer Vibes' } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
  return { eventId, vendorId, token };
}

const url = (eventId: unknown) => `/api/tickets/events/${eventId}/stock/reconciliation.pdf`;

describe('GET /api/tickets/events/:id/stock/reconciliation.pdf', () => {
  it('streams a PDF of the reconciliation to the owner', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const bar = await Merchant.create({ name: 'Main Bar', eventId, loginCode: String(seq++), pin: '000000' } as any);
    const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
    await StockService.applyMovement({ eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id), delta: 80, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' } as any);

    const res = await request(app).get(url(eventId)).set('Authorization', `Bearer ${token}`).buffer().parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');

    const text = extractPdfText(res.body as Buffer);
    // The numbers on the page must be the ones the JSON endpoint reports.
    expect(text).toContain('Ocean Summer Vibes');
    expect(text).toContain('Main Bar');
    expect(text).toContain('Castle Lite');
    expect(text).toContain('80');
  });

  it('names the file after the event', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const res = await request(app).get(url(eventId)).set('Authorization', `Bearer ${token}`);
    expect(res.headers['content-disposition']).toContain('stock-reconciliation-Ocean-Summer-Vibes');
  });

  it('rejects an anonymous caller', async () => {
    const { eventId } = await ownedCashlessEvent();
    const res = await request(app).get(url(eventId));
    expect(res.status).toBe(401);
  });

  it('rejects a caller without VIEW_REVENUE', async () => {
    const { eventId } = await ownedCashlessEvent();
    const token = signVendorToken('anyone', { permissions: [] });
    const res = await request(app).get(url(eventId)).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("forbids another vendor's event", async () => {
    const { eventId } = await ownedCashlessEvent();
    const token = signVendorToken('someone-else', { permissions: [TicketsPermission.VIEW_REVENUE] });
    const res = await request(app).get(url(eventId)).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('400s a non-cashless event', async () => {
    const { eventId, vendorId } = await seedPublishedEvent({}); // cashless stays false
    const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
    const res = await request(app).get(url(eventId)).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
