// src/routes/__tests__/stockReportReconciliation.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 550000;

it('returns a reconciliation row for the owner', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
  const bar = await Merchant.create({ name: 'Bar 1', eventId, loginCode: String(seq++), pin: '000000' } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  await StockService.applyMovement({ eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id), delta: 80, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' } as any);

  const res = await request(app).get(`/api/tickets/events/${eventId}/stock/reconciliation`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.total.expectedClosing).toBe(80);
});
