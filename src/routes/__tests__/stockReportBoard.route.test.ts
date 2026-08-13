// src/routes/__tests__/stockReportBoard.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 540000;

async function ownedCashlessEvent(perms = [TicketsPermission.VIEW_REVENUE]) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: perms });
  return { eventId: String(eventId), vendorId: String(vendorId), token };
}

describe('GET /api/tickets/events/:id/stock/board', () => {
  it('returns per-bar + aggregated board for the owner', async () => {
    const { eventId, token } = await ownedCashlessEvent();
    const bar = await Merchant.create({ name: 'Main Bar', eventId, loginCode: String(seq++), pin: '000000' } as any);
    const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
    await ProductStock.create({ eventId, merchantId: bar._id, productId: p._id, onHand: 0, lowStockThreshold: 5 } as any);

    const res = await request(app).get(`/api/tickets/events/${eventId}/stock/board`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.perBar[0].status).toBe('SOLD_OUT');
    expect(res.body.data.byProduct[0].totalOnHand).toBe(0);
  });

  it('rejects a caller without VIEW_REVENUE', async () => {
    const { eventId } = await ownedCashlessEvent();
    const token = signVendorToken('anyone', { permissions: [] });
    const res = await request(app).get(`/api/tickets/events/${eventId}/stock/board`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("forbids another vendor's event", async () => {
    const { eventId } = await ownedCashlessEvent();
    const token = signVendorToken('someone-else', { permissions: [TicketsPermission.VIEW_REVENUE] });
    const res = await request(app).get(`/api/tickets/events/${eventId}/stock/board`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('400s a non-cashless event', async () => {
    const { eventId: eid, vendorId } = await seedPublishedEvent({});   // cashless stays false
    const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
    const res = await request(app).get(`/api/tickets/events/${eid}/stock/board`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
