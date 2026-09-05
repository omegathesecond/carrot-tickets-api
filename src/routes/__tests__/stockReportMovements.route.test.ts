// src/routes/__tests__/stockReportMovements.route.test.ts
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
import { MerchantOperator } from '@models/merchantOperator.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 570000;

it('lists the journal newest-first for the owner', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });
  const bar = await Merchant.create({ name: 'Bar 1', eventId, loginCode: String(seq++), pin: '000000' } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  await StockService.applyMovement({ eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id), delta: 20, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: 'v1' } as any);

  const res = await request(app).get(`/api/tickets/events/${eventId}/stock/movements`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.movements[0]).toMatchObject({ reason: 'receive', delta: 20, productName: 'Castle Lite' });
});

it('400s malformed query params instead of 500ing', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  const badLimit = await request(app).get(`/api/tickets/events/${eventId}/stock/movements?limit=abc`).set('Authorization', `Bearer ${token}`);
  expect(badLimit.status).toBe(400);
  const badProduct = await request(app).get(`/api/tickets/events/${eventId}/stock/movements?productId=not-an-id`).set('Authorization', `Bearer ${token}`);
  expect(badProduct.status).toBe(400);
});

it('names the stall operator behind a POS movement', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  const bar = await Merchant.create({ name: 'Sandwich Stall', eventId } as any);
  const operator = await MerchantOperator.create({
    fullName: 'Nomsa Shongwe', merchantId: bar._id, eventId,
    loginCode: String(seq++), pin: '111111',
  });
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);

  // Exactly what the POS receive route writes: attributed to the PERSON.
  await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id),
    delta: 24, reason: StockMovementReason.RECEIVE,
    byType: 'Merchant', by: String(operator._id),
  } as any);

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/movements`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.data.movements[0]).toMatchObject({
    by: String(operator._id),
    byName: 'Nomsa Shongwe',
  });
});

it('leaves byName null for organizer-written movements', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  const bar = await Merchant.create({ name: 'Bar 1', eventId } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  // Organizer-written rows put a vendorId (not an ObjectId person) in `by`.
  await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id),
    delta: 20, reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: String(vendorId),
  } as any);

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/movements`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.body.data.movements[0].byName).toBeNull();
});

it('falls back rather than leaking a bare id when the operator is gone', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  const bar = await Merchant.create({ name: 'Sandwich Stall', eventId } as any);
  const operator = await MerchantOperator.create({
    fullName: 'Temp Staff', merchantId: bar._id, eventId,
    loginCode: String(seq++), pin: '111111',
  });
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id),
    delta: 5, reason: StockMovementReason.RECEIVE, byType: 'Merchant', by: String(operator._id),
  } as any);
  await MerchantOperator.deleteOne({ _id: operator._id });

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/movements`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.body.data.movements[0].byName).toBe('Unknown operator');
});

it('200s (not 500s) a Merchant-typed row whose by is not a valid ObjectId', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  const bar = await Merchant.create({ name: 'Sandwich Stall', eventId } as any);
  const p = await Product.create({ eventId, name: 'Castle Lite', category: 'beer', price: 2500 } as any);
  // A corrupt/hand-edited row: byType says Merchant but `by` isn't a real
  // operator id. Must not reach an ObjectId cast (that would 500 the whole
  // endpoint) — the HEX24 guard has to exclude it from the $in lookup.
  await StockService.applyMovement({
    eventId: String(eventId), merchantId: String(bar._id), productId: String(p._id),
    delta: 3, reason: StockMovementReason.RECEIVE, byType: 'Merchant', by: 'not-an-id',
  } as any);

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/movements`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.data.movements[0].byName).toBe('Unknown operator');
});
