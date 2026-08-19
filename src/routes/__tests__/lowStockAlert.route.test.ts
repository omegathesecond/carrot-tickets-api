// src/routes/__tests__/lowStockAlert.route.test.ts
// Merchant-JWT harness (as merchantChargeItems.route.test.ts) + a MANAGE_STOCK vendor token for receive/threshold.
// Flow: threshold=5 on a product with onHand 6; sell 2 (→4, crosses) → one low_stock vendor notification;
// sell 1 more (→3, still armed) → NO second notification; receive 10 (→13, above) re-arms; sell 9 (→4) → alerts again.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { WalletService } from '@services/wallet.service';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Product } from '@models/product.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { Notification } from '@models/notification.model';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// A merchant token names the STALL and the PERSON on its till; without the
// person authenticateMerchant rejects it.
const mToken = (merchantId: string, eventId: string, merchantOperatorId: string) => jwt.sign({
  scope: 'merchant', merchantId, merchantOperatorId,
  operatorName: 'Thabo Dlamini', eventId, name: 'Bar', permissions: [MerchantPermission.CHARGE],
}, JWT_SECRET);
const lowStockCount = (vendorId: string) => Notification.countDocuments({ recipientType: 'vendor', recipientId: vendorId, type: 'low_stock' });

async function setup() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const t = await Ticket.create({ eventId, vendorId, ticketType: 'GA', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  const bandUid = '04b1c2d3e4f5'; await WalletService.bindBand(String(w._id), bandUid, 'op1');
  await WalletService.topUpCash({ walletId: String(w._id), eventId: String(eventId), amount: 1_000_000, recordedBy: 'op1', clientTxnId: 'seed' });
  const merchant = await Merchant.create({ name: 'Bar', eventId, commissionPercent: 0 });
  // The charge transaction re-reads the operator and refuses a missing or
  // deactivated one, so the token has to name a row that really exists.
  const operator = await MerchantOperator.create({
    fullName: 'Thabo Dlamini', merchantId: merchant._id, eventId, loginCode: '4KZ902', pin: '111111',
  });
  const product = await Product.create({ eventId, name: 'Beer', category: 'beer', price: 100 });
  await StockService.applyMovement({ eventId, merchantId: merchant._id, productId: product._id, delta: 6, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' });
  // set threshold 5 via the organizer endpoint
  const vToken = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  await request(app).patch(`/api/tickets/events/${eventId}/stock/threshold`).set('Authorization', `Bearer ${vToken}`).send({ merchantId: String(merchant._id), productId: String(product._id), lowStockThreshold: 5 });
  return {
    eventId: String(eventId), vendorId: String(vendorId), bandUid, merchantId: String(merchant._id),
    merchantOperatorId: String(operator._id), productId: String(product._id), vToken,
  };
}
const sell = (m: string, e: string, op: string, band: string, productId: string, qty: number, id: string) =>
  request(app).post('/api/merchant/charge').set('Authorization', `Bearer ${mToken(m, e, op)}`).send({ bandUid: band, clientTxnId: id, items: [{ productId, qty }] });

it('alerts once on downward crossing, stays quiet while armed, re-alerts after replenish', async () => {
  const { eventId, vendorId, bandUid, merchantId, merchantOperatorId, productId, vToken } = await setup();
  expect((await sell(merchantId, eventId, merchantOperatorId, bandUid, productId, 2, 'c1')).status).toBe(200); // 6→4, crosses 5
  await new Promise((r) => setTimeout(r, 150)); // let the fire-and-forget alert land
  expect(await lowStockCount(vendorId)).toBe(1);
  expect((await sell(merchantId, eventId, merchantOperatorId, bandUid, productId, 1, 'c2')).status).toBe(200); // 4→3, still armed
  await new Promise((r) => setTimeout(r, 150));
  expect(await lowStockCount(vendorId)).toBe(1); // no second alert
  // replenish above threshold → re-arm
  await request(app).post(`/api/tickets/events/${eventId}/stock/receive`).set('Authorization', `Bearer ${vToken}`).send({ merchantId, productId, quantity: 10 }); // 3→13
  expect((await sell(merchantId, eventId, merchantOperatorId, bandUid, productId, 9, 'c3')).status).toBe(200); // 13→4, crosses again
  await new Promise((r) => setTimeout(r, 150));
  expect(await lowStockCount(vendorId)).toBe(2);
});
