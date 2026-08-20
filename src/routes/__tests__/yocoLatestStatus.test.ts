/**
 * GET /api/public/purchase/yoco/latest/status
 *
 * The authenticated replacement for the identifiers the return URL used to leak.
 * Also guards a routing trap: this path must be declared BEFORE
 * /purchase/yoco/:checkoutId/status, or Express captures "latest" as a checkout
 * id and the endpoint silently 404s as "Payment not found".
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken } from '@/__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import publicRoutes from '@routes/public.route';

const app = express();
app.use(express.json());
app.use('/api/public', publicRoutes);

const PHONE = '+26878422613';
const auth = () => ({ Authorization: `Bearer ${signBuyerToken(PHONE)}` });

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedBuyerWithYocoSale(status: PaymentStatus, checkoutId = 'ch_latest') {
  const buyer = await Buyer.create({
    phone: PHONE, password: 'secret123', username: 'tester',
    avatarUrl: 'https://cdn.test/a.jpg',
  });
  await TicketSale.create({
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    buyerId: buyer._id,
    ticketIds: [], quantity: 1, totalAmount: 50, amountCharged: 65,
    customerPhone: PHONE,
    paymentMethod: PaymentMethod.YOCO, paymentStatus: status,
    yocoCheckoutId: checkoutId,
    soldBy: new mongoose.Types.ObjectId(), soldByType: 'Vendor', soldAt: new Date(),
  });
  return buyer;
}

describe('yoco latest status', () => {
  it('is NOT swallowed by the /:checkoutId/status route', async () => {
    await seedBuyerWithYocoSale(PaymentStatus.COMPLETED);

    const res = await request(app).get('/api/public/purchase/yoco/latest/status').set(auth());

    // If "latest" were captured as a checkout id, this would 404 "Payment not found".
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('completed');
  });

  it('reports a pending sale as pending', async () => {
    await seedBuyerWithYocoSale(PaymentStatus.PENDING);

    const res = await request(app).get('/api/public/purchase/yoco/latest/status').set(auth());

    expect(res.body.data.status).toBe('pending');
  });

  it('reports a failed sale as failed', async () => {
    await seedBuyerWithYocoSale(PaymentStatus.FAILED);

    const res = await request(app).get('/api/public/purchase/yoco/latest/status').set(auth());

    expect(res.body.data.status).toBe('failed');
  });

  it("returns 'none' when the buyer has no Yoco purchase, distinct from a failure", async () => {
    await Buyer.create({
      phone: PHONE, password: 'secret123', username: 'tester',
      avatarUrl: 'https://cdn.test/a.jpg',
    });

    const res = await request(app).get('/api/public/purchase/yoco/latest/status').set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('none');
  });

  it('requires authentication — an anonymous caller learns nothing', async () => {
    await seedBuyerWithYocoSale(PaymentStatus.COMPLETED);

    const res = await request(app).get('/api/public/purchase/yoco/latest/status');

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('ch_latest');
  });

  it("never returns another buyer's sale", async () => {
    // Sale belongs to someone else entirely — no buyerId/phone match.
    await TicketSale.create({
      eventId: new mongoose.Types.ObjectId(), vendorId: new mongoose.Types.ObjectId(),
      buyerId: new mongoose.Types.ObjectId(),
      ticketIds: [], quantity: 1, totalAmount: 50, amountCharged: 65,
      customerPhone: '+26879999999',
      paymentMethod: PaymentMethod.YOCO, paymentStatus: PaymentStatus.COMPLETED,
      yocoCheckoutId: 'ch_someone_else',
      soldBy: new mongoose.Types.ObjectId(), soldByType: 'Vendor', soldAt: new Date(),
    });
    await Buyer.create({
      phone: PHONE, password: 'secret123', username: 'tester',
      avatarUrl: 'https://cdn.test/a.jpg',
    });

    const res = await request(app).get('/api/public/purchase/yoco/latest/status').set(auth());

    expect(res.body.data.status).toBe('none');
    expect(JSON.stringify(res.body)).not.toContain('ch_someone_else');
  });
});
