// Allocation = the existence of a ProductStock row. These routes let the
// organizer state it directly instead of having to receive stock to imply it.
// Harness mirrors stockAdmin.route.test.ts: signVendorToken + seedPublishedEvent.
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

async function ownedCashlessEvent() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.MANAGE_STOCK] });
  return { eventId: String(eventId), token };
}

const stall = async (eventId: string, name: string) =>
  String((await Merchant.create({ name, eventId }))._id);

const product = async (eventId: string, name: string) =>
  String((await Product.create({ eventId, name, category: 'beer', price: 2500, unitLabel: 'unit', active: true }))._id);

const put = (eventId: string, token: string, body: Record<string, unknown>) =>
  request(app).put(`/api/tickets/events/${eventId}/stock/allocations`)
    .set('Authorization', `Bearer ${token}`).send(body);

it('allocates a product to two stalls by creating zero-quantity rows', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const shi = await stall(eventId, 'Shisanyama');
  const beer = await product(eventId, 'Castle Lite 330ml');

  const res = await put(eventId, token, { productId: beer, merchantIds: [bar, shi] });

  expect(res.status).toBe(200);
  expect(res.body.data.allocated.sort()).toEqual([bar, shi].sort());
  const rows = await ProductStock.find({ productId: beer }).lean();
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.onHand === 0)).toBe(true);
});

it('is idempotent and never resets an existing quantity', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  await ProductStock.create({ merchantId: bar, productId: beer, eventId, onHand: 40 });

  const res = await put(eventId, token, { productId: beer, merchantIds: [bar] });

  expect(res.status).toBe(200);
  // Re-allocating a stall that already carries 40 must not zero it.
  expect((await ProductStock.findOne({ merchantId: bar, productId: beer }))!.onHand).toBe(40);
});

it('reports every product at the event, including one allocated to nobody', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  const orphan = await product(eventId, 'Quarter Chicken');
  await put(eventId, token, { productId: beer, merchantIds: [bar] });

  const res = await request(app)
    .get(`/api/tickets/events/${eventId}/stock/allocations`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.body.data.allocations[beer]).toEqual([bar]);
  // Present as a key with an empty list — that is what lets the dashboard
  // flag "not on any stall" rather than silently omitting the product.
  expect(res.body.data.allocations[orphan]).toEqual([]);
});

it('refuses a stall belonging to a different event', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const other = await ownedCashlessEvent();
  const foreign = await stall(other.eventId, 'Someone Else Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');

  const res = await put(eventId, token, { productId: beer, merchantIds: [foreign] });

  expect(res.status).toBe(400);
  expect(await ProductStock.countDocuments({ productId: beer })).toBe(0);
});

it('refuses a product belonging to a different event', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const other = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const foreignProduct = await product(other.eventId, 'Not Ours');

  const res = await put(eventId, token, { productId: foreignProduct, merchantIds: [bar] });

  expect(res.status).toBe(400);
});

it('refuses an organizer who does not own the event', async () => {
  const { eventId } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  const intruder = signVendorToken('64b7c1f1f1f1f1f1f1f1f1f1', { permissions: [TicketsPermission.MANAGE_STOCK] });

  const res = await put(eventId, intruder, { productId: beer, merchantIds: [bar] });

  expect(res.status).toBe(403);
});

it('refuses to delist a stall that still holds stock, naming it and the quantity', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  await ProductStock.create({ merchantId: bar, productId: beer, eventId, onHand: 12 });

  const res = await put(eventId, token, { productId: beer, merchantIds: [] });

  expect(res.status).toBe(400);
  // ApiResponseUtil.badRequest(res, message) puts the text in `message`; the
  // separate `error` field is an optional second argument nothing here passes.
  expect(res.body.message).toContain('Bar');
  expect(res.body.message).toContain('12');
  // Nothing removed: the row and its stock survive the refusal intact.
  expect((await ProductStock.findOne({ merchantId: bar, productId: beer }))!.onHand).toBe(12);
});

it('allows delisting a stall holding nothing', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const beer = await product(eventId, 'Castle Lite 330ml');
  await ProductStock.create({ merchantId: bar, productId: beer, eventId, onHand: 0 });

  const res = await put(eventId, token, { productId: beer, merchantIds: [] });

  expect(res.status).toBe(200);
  expect(res.body.data.allocated).toEqual([]);
  expect(await ProductStock.countDocuments({ productId: beer })).toBe(0);
});

it('refuses the whole request when one of several delisted stalls holds stock', async () => {
  const { eventId, token } = await ownedCashlessEvent();
  const bar = await stall(eventId, 'Bar');
  const shi = await stall(eventId, 'Shisanyama');
  const beer = await product(eventId, 'Castle Lite 330ml');
  await ProductStock.create({ merchantId: bar, productId: beer, eventId, onHand: 0 });
  await ProductStock.create({ merchantId: shi, productId: beer, eventId, onHand: 3 });

  const res = await put(eventId, token, { productId: beer, merchantIds: [] });

  expect(res.status).toBe(400);
  // All-or-nothing: the empty-handed stall must not be delisted either, or a
  // retry after writing off the 3 would silently leave the catalogue changed.
  expect(await ProductStock.countDocuments({ productId: beer })).toBe(2);
});
