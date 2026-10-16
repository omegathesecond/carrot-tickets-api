import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedEventWithTiers } from '@/__tests__/helpers/fixtures';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { EventCoupon } from '@models/eventCoupon.model';
import { Ticket } from '@models/ticket.model';
import { EmailService } from '@services/email.service';
import { TicketsAuthService } from '@services/ticketsAuth.service';

beforeAll(connectLedgerTestDb, 60000);
afterAll(disconnectTestDb);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDb(); });

async function fixture() {
  const vendor = await Vendor.create({ businessName: 'Coupon organizer', email: 'coupons@example.test', password: 'password123' });
  const buyer = await Buyer.create({ email: 'guest@example.test', password: 'password123', name: 'Guest' });
  const event = await seedEventWithTiers([{ name: 'General', price: 100, quantity: 10 }], { vendorId: vendor._id });
  const sign = (claims: object) => jwt.sign({ app: 'tickets', ...claims }, process.env['JWT_SECRET']!);
  return { ...event, owner: sign({ userType: 'vendor', authVersion: vendor.authVersion, vendorId: String(vendor._id) }),
    buyer: sign({ userType: 'buyer', authVersion: buyer.authVersion, buyerId: String(buyer._id) }),
    body: { eventId: event.eventId, items: [{ ticketTypeId: event.ticketTypeIds[0], quantity: 1 }] } };
}

it('requires organizer auth, rejects client-supplied prices, and supports quote → free redemption → used', async () => {
  const f = await fixture();
  await request(app).post(`/api/tickets/events/${f.eventId}/coupons`).send({ discountType: 'percentage', discountValue: 100 }).expect(401);
  const created = await request(app).post(`/api/tickets/events/${f.eventId}/coupons`).set('Authorization', `Bearer ${f.owner}`).send({ discountType: 'percentage', discountValue: 100 }).expect(201);
  const code = created.body.data.coupons[0].code;
  await request(app).post('/api/public/coupons/quote').send({ ...f.body, couponCode: code, method: 'cash' }).expect(401);
  await request(app).post('/api/public/coupons/quote').set('Authorization', `Bearer ${f.buyer}`).send({ ...f.body, couponCode: code, method: 'cash', discountAmount: 999 }).expect(400);
  const quote = await request(app).post('/api/public/coupons/quote').set('Authorization', `Bearer ${f.buyer}`).send({ ...f.body, couponCode: code.toLowerCase(), method: 'cash' }).expect(200);
  expect(quote.body.data).toMatchObject({ amountCharged: 0, discountAmount: 100 });
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  await request(app).post('/api/public/purchase/free').set('Authorization', `Bearer ${f.buyer}`).send({ ...f.body, couponCode: code }).expect(201);
  expect(await Ticket.countDocuments()).toBe(1);
  const usage = await request(app).get(`/api/tickets/events/${f.eventId}/coupons`).set('Authorization', `Bearer ${f.owner}`).expect(200);
  expect(usage.body.data.coupons[0].status).toBe('used');
  await request(app).post('/api/public/purchase/free').set('Authorization', `Bearer ${f.buyer}`).send({ ...f.body, couponCode: code }).expect(409);
  expect(await Ticket.countDocuments()).toBe(1);
});

it('enforces organizer ownership on listing, generation and disable', async () => {
  const f = await fixture();
  const other = await Vendor.create({ businessName: 'Other organizer', email: 'other@example.test', password: 'password123' });
  const token = jwt.sign({ app: 'tickets', authVersion: other.authVersion, userType: 'vendor', vendorId: String(other._id) }, process.env['JWT_SECRET']!);
  const base = `/api/tickets/events/${f.eventId}/coupons`;
  await request(app).get(base).set('Authorization', `Bearer ${token}`).expect(404);
  await request(app).post(base).set('Authorization', `Bearer ${token}`).send({ discountType: 'percentage', discountValue: 10 }).expect(404);
  const coupon = await EventCoupon.create({ eventId: f.eventId, vendorId: f.vendorId, code: 'CT-0123456789ABCDEF', discountType: 'fixed', discountValue: 10 });
  await request(app).post(`${base}/${coupon._id}/disable`).set('Authorization', `Bearer ${token}`).expect(404);
  expect((await EventCoupon.findById(coupon._id))!.disabled).toBe(false);
});

it('requires the event-edit permission on every organizer coupon operation', async () => {
  const f = await fixture();
  // Isolate the authorization contract from the login/token tests above.
  jest.spyOn(TicketsAuthService, 'verifyAndResolveSession').mockResolvedValue({ app: 'tickets', userType: 'vendor', vendorId: f.vendorId, permissions: [] });
  const base = `/api/tickets/events/${f.eventId}/coupons`;
  await request(app).get(base).set('Authorization', 'Bearer no-permissions').expect(403);
  await request(app).post(base).set('Authorization', 'Bearer no-permissions').send({ discountType: 'percentage', discountValue: 10 }).expect(403);
  await request(app).post(`${base}/012345678901234567890123/disable`).set('Authorization', 'Bearer no-permissions').expect(403);
});
