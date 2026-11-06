import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVendorSessionToken } from '@/__tests__/helpers/auth';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { Event } from '@models/event.model';
import { PosCatalogService } from '@services/posCatalog.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDb(); });
afterAll(disconnectTestDb);

async function fixture(permission = TicketsPermission.MANAGE_ACCESS) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { currency: 'ZAR' } });
  const merchant = await Merchant.create({ name: 'The Meat Hub', eventId });
  const token = await seedVendorSessionToken(vendorId, { permissions: [permission] });
  return { eventId, merchant, token };
}

it.each([TicketsPermission.MANAGE_ACCESS, TicketsPermission.MANAGE_STOCK])('shows only assigned active menu items with %s', async permission => {
  const { eventId, merchant, token } = await fixture(permission);
  const product = await Product.create({ eventId, name: 'Beef & Pap', category: 'food', price: 10000, stockTracked: false });
  const retired = await Product.create({ eventId, name: 'Old meal', category: 'food', price: 2000, active: false });
  await Product.create({ eventId, name: 'Another stall meal', category: 'food', price: 5000 });
  await ProductStock.create({ eventId, merchantId: merchant._id, productId: product._id, onHand: 0 });
  await ProductStock.create({ eventId, merchantId: merchant._id, productId: retired._id, onHand: 0 });
  const res = await request(app).get(`/api/tickets/merchants/${merchant._id}/menu`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.data.event).toMatchObject({ id: eventId, currency: 'ZAR' });
  expect(res.body.data.products).toHaveLength(1);
  expect(res.body.data.products[0]).toMatchObject({ productId: String(product._id), name: 'Beef & Pap', price: 10000, status: 'untracked' });
});

it('refuses another organizer’s stall', async () => {
  const { merchant } = await fixture();
  const { vendorId } = await seedPublishedEvent({});
  const token = await seedVendorSessionToken(vendorId, { permissions: [TicketsPermission.MANAGE_ACCESS] });
  const res = await request(app).get(`/api/tickets/merchants/${merchant._id}/menu`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(403);
});

it('refuses a user without either menu permission', async () => {
  const { merchant, token } = await fixture(TicketsPermission.SCAN_TICKETS);
  const res = await request(app).get(`/api/tickets/merchants/${merchant._id}/menu`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(403);
});

it('returns 404 for a deleted stall', async () => {
  const { merchant, token } = await fixture();
  await Merchant.updateOne({ _id: merchant._id }, { $set: { deletedAt: new Date() } });
  const res = await request(app).get(`/api/tickets/merchants/${merchant._id}/menu`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(404);
});

it('surfaces catalogue failures instead of returning an empty menu', async () => {
  const { merchant, token } = await fixture();
  jest.spyOn(PosCatalogService, 'forMerchant').mockRejectedValue(new Error('Catalogue unavailable'));
  const res = await request(app).get(`/api/tickets/merchants/${merchant._id}/menu`).set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(500);
  expect(res.body.success).toBe(false);
});
