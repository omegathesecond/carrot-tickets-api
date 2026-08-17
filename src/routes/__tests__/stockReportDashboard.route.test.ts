// src/routes/__tests__/stockReportDashboard.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 560000;

it('returns the dashboard with the itemised split for the owner', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
  const bar = await Merchant.create({ name: 'Bar 1', eventId, loginCode: String(seq++), pin: '000000' } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  await MerchantCharge.create({ merchantId: bar._id, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b', amount: 5000, fee: 0, netAmount: 5000, clientTxnId: 't1', status: 'completed', items: [{ productId: p._id, name: 'Castle Lite', unitPrice: 2500, qty: 2, lineTotal: 5000 }] } as any);
  await MerchantCharge.create({ merchantId: bar._id, eventId, walletId: new mongoose.Types.ObjectId(), bandUid: 'b', amount: 1500, fee: 0, netAmount: 1500, clientTxnId: 't2', status: 'completed' } as any);

  const res = await request(app).get(`/api/tickets/events/${eventId}/stock/dashboard`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.itemisedSplit.itemised.gross).toBe(5000);
  expect(res.body.data.itemisedSplit.unitemised.gross).toBe(1500);
});
