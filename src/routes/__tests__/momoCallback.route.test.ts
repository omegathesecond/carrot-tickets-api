// MTN MoMo callback (PUT/POST /api/momo/callback) — menu preorders.
//
// MTN's requesttopay callback keys on `externalId` (what WE sent — for a menu
// order that is order.orderId) and usually carries no X-Reference-Id. Before
// this suite, the callback only resolved ticket and bus-booking sales, so a
// buyer who approved on the handset and closed the tab left a menu order
// PENDING forever while MTN had already taken the money. The callback must
// finalise the order — and finalisation must stay idempotent, because MTN
// retries and the buyer's status poll may race it.

import request from 'supertest';
import mongoose from 'mongoose';

const mockMomoInstance = {
  isConfigured: jest.fn(),
  requestToPay: jest.fn(),
  getStatus: jest.fn(),
};
jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => mockMomoInstance),
}));

import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { MenuOrder } from '@models/menuOrder.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

const VENDOR = new mongoose.Types.ObjectId();
const BUYER = new mongoose.Types.ObjectId();

async function pendingMomoOrder(orderId: string, referenceId: string) {
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId: VENDOR, name: 'Menu Night', venue: 'V',
    eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return MenuOrder.create({
    orderId, eventId: event._id, vendorId: VENDOR, buyerId: BUYER,
    items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Lager', unitPrice: 2500, quantity: 1, lineTotal: 2500 }],
    subtotal: 2500, serviceFeeAmount: 200, amountCharged: 2700, // E27.00
    paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.PENDING,
    momoReferenceId: referenceId,
  });
}

beforeAll(connectTestDb);
afterEach(async () => { await clearTestDb(); jest.clearAllMocks(); });
afterAll(disconnectTestDb);

describe('POST /api/momo/callback — menu preorders', () => {
  it('finalises a PENDING menu order when the callback carries the order id as externalId', async () => {
    await pendingMomoOrder('MENU-1-ABC', 'REF-MENU-1');
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '27', currency: 'SZL' } });

    const res = await request(app).post('/api/momo/callback')
      .send({ externalId: 'MENU-1-ABC', status: 'SUCCESSFUL', amount: '27', currency: 'SZL' });

    expect(res.status).toBe(200);
    expect(mockMomoInstance.getStatus).toHaveBeenCalledWith('REF-MENU-1');
    const order = await MenuOrder.findOne({ orderId: 'MENU-1-ABC' });
    expect(order!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(order!.paidAt).toBeInstanceOf(Date);
  });

  it('finalises a menu order when the callback carries only the MoMo referenceId', async () => {
    await pendingMomoOrder('MENU-2-DEF', 'REF-MENU-2');
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '27', currency: 'SZL' } });

    const res = await request(app).put('/api/momo/callback').send({ referenceId: 'REF-MENU-2' });

    expect(res.status).toBe(200);
    const order = await MenuOrder.findOne({ orderId: 'MENU-2-DEF' });
    expect(order!.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });

  it('marks the order FAILED when MTN reports FAILED', async () => {
    await pendingMomoOrder('MENU-3-GHI', 'REF-MENU-3');
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'FAILED', raw: { reason: 'PAYER_NOT_FOUND' } });

    await request(app).post('/api/momo/callback').send({ externalId: 'MENU-3-GHI' });

    const order = await MenuOrder.findOne({ orderId: 'MENU-3-GHI' });
    expect(order!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(order!.momoFailureReason).toBe('PAYER_NOT_FOUND');
  });

  it('is idempotent — a retried callback on a completed order asks MTN nothing and changes nothing', async () => {
    const order = await pendingMomoOrder('MENU-4-JKL', 'REF-MENU-4');
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '27', currency: 'SZL' } });

    await request(app).post('/api/momo/callback').send({ externalId: 'MENU-4-JKL' });
    const paidAt = (await MenuOrder.findById(order._id))!.paidAt;
    mockMomoInstance.getStatus.mockClear();

    const res = await request(app).post('/api/momo/callback').send({ externalId: 'MENU-4-JKL' });

    expect(res.status).toBe(200);
    expect(mockMomoInstance.getStatus).not.toHaveBeenCalled();
    const after = await MenuOrder.findById(order._id);
    expect(after!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(after!.paidAt!.getTime()).toBe(paidAt!.getTime());
  });

  it('still 400s when nothing at all matches the externalId', async () => {
    const res = await request(app).post('/api/momo/callback').send({ externalId: 'NOPE-000' });

    expect(res.status).toBe(400);
    expect(mockMomoInstance.getStatus).not.toHaveBeenCalled();
  });
});
