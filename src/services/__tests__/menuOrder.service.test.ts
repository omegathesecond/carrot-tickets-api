// MenuOrderService — the DB-backed rules behind a menu preorder.
//
//  - Orders are only accepted against a PUBLISHED event.
//  - The externalId handed to MTN is the order's orderId, and the service can
//    resolve an order back from it (that is how the MoMo callback correlates).
//  - reconcilePendingMomoOrders is the backstop for a lost callback: it asks
//    MTN about PENDING MoMo orders older than the grace window and finalises
//    them through the same idempotent finaliser the buyer's poll uses.
//  - Duplicate lines of one item are merged before the per-line cap applies.

import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

const mockMomoInstance = {
  isConfigured: jest.fn(),
  requestToPay: jest.fn(),
  getStatus: jest.fn(),
};
jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => mockMomoInstance),
}));
jest.mock('@services/keshlessPayment.service');

import { MenuOrderService } from '@services/menuOrder.service';
import { KeshlessPaymentService } from '@services/keshlessPayment.service';
import { Event } from '@models/event.model';
import { MenuItem, MenuSection } from '@models/menuItem.model';
import { MenuOrder } from '@models/menuOrder.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

const acceptPayment = KeshlessPaymentService.acceptPayment as jest.MockedFunction<typeof KeshlessPaymentService.acceptPayment>;

const VENDOR = new mongoose.Types.ObjectId();
const BUYER = new mongoose.Types.ObjectId().toString();

async function eventWith(status: EventStatus): Promise<string> {
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId: VENDOR, name: 'Menu Night', venue: 'V',
    eventDate: future, startTime: future, endTime: future, status,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return event._id.toString();
}

async function menuItem(eventId: string, price = 2500): Promise<string> {
  const item = await MenuItem.create({ eventId, section: MenuSection.BAR, category: 'Beer', name: 'Lager', price });
  return item._id.toString();
}

function keshlessOk() {
  acceptPayment.mockResolvedValue({
    status: 'completed', transactionId: 'KTX-1', amount: 25, feeAmount: 0, totalAmount: 25, vendorReceived: 25,
  });
}

/** A PENDING MoMo order with a reference, created `ageMs` ago. */
async function pendingMomoOrder(referenceId: string, ageMs: number) {
  const eventId = await eventWith(EventStatus.PUBLISHED);
  return MenuOrder.create({
    orderId: `MENU-${referenceId}`, eventId, vendorId: VENDOR, buyerId: new mongoose.Types.ObjectId(),
    items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Lager', unitPrice: 2500, quantity: 1, lineTotal: 2500 }],
    subtotal: 2500, serviceFeeAmount: 200, amountCharged: 2700,
    paymentMethod: PaymentMethod.MTN_MOMO, paymentStatus: PaymentStatus.PENDING,
    momoReferenceId: referenceId,
    createdAt: new Date(Date.now() - ageMs),
  });
}

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
  mockMomoInstance.isConfigured.mockReset();
  mockMomoInstance.requestToPay.mockReset();
  mockMomoInstance.getStatus.mockReset();
});
afterAll(disconnectTestDb);

describe('published-event gate', () => {
  it('createKeshlessOrder refuses a DRAFT event and writes nothing', async () => {
    const eventId = await eventWith(EventStatus.DRAFT);
    const itemId = await menuItem(eventId);
    keshlessOk();

    await expect(MenuOrderService.createKeshlessOrder({
      eventId, buyerId: BUYER, items: [{ menuItemId: itemId, quantity: 1 }], keshlessCardNumber: '1234',
    })).rejects.toThrow('Event not found or not open for orders');

    expect(await MenuOrder.countDocuments({})).toBe(0);
    expect(acceptPayment).not.toHaveBeenCalled();
  });

  it('initiateMomoOrder refuses a COMPLETED event and never calls MTN', async () => {
    const eventId = await eventWith(EventStatus.COMPLETED);
    const itemId = await menuItem(eventId);
    mockMomoInstance.isConfigured.mockReturnValue(true);

    await expect(MenuOrderService.initiateMomoOrder({
      eventId, buyerId: BUYER, items: [{ menuItemId: itemId, quantity: 1 }], momoPhone: '76111111',
    })).rejects.toThrow('Event not found or not open for orders');

    expect(await MenuOrder.countDocuments({})).toBe(0);
    expect(mockMomoInstance.requestToPay).not.toHaveBeenCalled();
  });

  it('initiateMomoOrder accepts a PUBLISHED event and hands MTN the orderId as externalId', async () => {
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId);
    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'REF-OK' });

    const r = await MenuOrderService.initiateMomoOrder({
      eventId, buyerId: BUYER, items: [{ menuItemId: itemId, quantity: 1 }], momoPhone: '76111111',
    });

    const order = await MenuOrder.findById(r.orderId);
    expect(order!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(order!.momoReferenceId).toBe('REF-OK');
    expect(mockMomoInstance.requestToPay).toHaveBeenCalledWith(expect.objectContaining({ externalId: order!.orderId }));
  });
});

describe('getMomoOrderByExternalId', () => {
  it('resolves an order from the externalId MTN echoes back (= orderId)', async () => {
    const order = await pendingMomoOrder('REF-X', 0);

    const found = await MenuOrderService.getMomoOrderByExternalId(order.orderId);

    expect(found).not.toBeNull();
    expect(found!.momoReferenceId).toBe('REF-X');
    expect(await MenuOrderService.getMomoOrderByExternalId('MENU-NOPE')).toBeNull();
  });
});

describe('reconcilePendingMomoOrders', () => {
  it('finalises a stale PENDING order that MTN reports SUCCESSFUL', async () => {
    const order = await pendingMomoOrder('REF-STALE', 3 * 60_000);
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '27', currency: 'SZL' } });

    const r = await MenuOrderService.reconcilePendingMomoOrders(90_000);

    expect(r).toEqual({ completed: 1, failed: 0, pending: 0 });
    expect(mockMomoInstance.getStatus).toHaveBeenCalledWith('REF-STALE');
    const after = await MenuOrder.findById(order._id);
    expect(after!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(after!.paidAt).toBeInstanceOf(Date);
  });

  it('leaves a brand-new PENDING order alone — the buyer may still be on the handset', async () => {
    await pendingMomoOrder('REF-FRESH', 5_000);

    const r = await MenuOrderService.reconcilePendingMomoOrders(90_000);

    expect(r).toEqual({ completed: 0, failed: 0, pending: 0 });
    expect(mockMomoInstance.getStatus).not.toHaveBeenCalled();
  });

  it('marks a stale order FAILED when MTN reports FAILED, and counts still-pending ones', async () => {
    const failed = await pendingMomoOrder('REF-FAIL', 3 * 60_000);
    const pending = await pendingMomoOrder('REF-WAIT', 3 * 60_000);
    mockMomoInstance.getStatus.mockImplementation(async (ref: string) =>
      ref === 'REF-FAIL' ? { status: 'FAILED', raw: { reason: 'PAYER_NOT_FOUND' } } : { status: 'PENDING', raw: {} });

    const r = await MenuOrderService.reconcilePendingMomoOrders(90_000);

    expect(r).toEqual({ completed: 0, failed: 1, pending: 1 });
    expect((await MenuOrder.findById(failed._id))!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect((await MenuOrder.findById(pending._id))!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('skips orders already finalised by the buyer poll or the callback', async () => {
    const order = await pendingMomoOrder('REF-DONE', 3 * 60_000);
    await MenuOrder.updateOne({ _id: order._id }, { $set: { paymentStatus: PaymentStatus.COMPLETED, paidAt: new Date() } });

    const r = await MenuOrderService.reconcilePendingMomoOrders(90_000);

    expect(r).toEqual({ completed: 0, failed: 0, pending: 0 });
    expect(mockMomoInstance.getStatus).not.toHaveBeenCalled();
  });

  it('one order MTN cannot answer for does not stop the rest of the batch', async () => {
    const broken = await pendingMomoOrder('REF-BROKEN', 3 * 60_000);
    const good = await pendingMomoOrder('REF-GOOD', 3 * 60_000);
    mockMomoInstance.getStatus.mockImplementation(async (ref: string) => {
      if (ref === 'REF-BROKEN') throw new Error('MTN down');
      return { status: 'SUCCESSFUL', raw: { amount: '27', currency: 'SZL' } };
    });

    const r = await MenuOrderService.reconcilePendingMomoOrders(90_000);

    expect(r).toEqual({ completed: 1, failed: 0, pending: 0 });
    expect((await MenuOrder.findById(good._id))!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect((await MenuOrder.findById(broken._id))!.paymentStatus).toBe(PaymentStatus.PENDING);
  });
});

describe('duplicate lines', () => {
  it('createKeshlessOrder merges two lines of the same item into one', async () => {
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId, 100);
    keshlessOk();

    const order = await MenuOrderService.createKeshlessOrder({
      eventId, buyerId: BUYER, keshlessCardNumber: '1234',
      items: [{ menuItemId: itemId, quantity: 2 }, { menuItemId: itemId, quantity: 3 }],
    });

    expect(order.items).toHaveLength(1);
    expect(order.items[0]!.quantity).toBe(5);
    expect(order.items[0]!.lineTotal).toBe(500);
    expect(order.subtotal).toBe(500);
  });

  it('createKeshlessOrder enforces the per-line cap on the MERGED quantity', async () => {
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId, 100);
    keshlessOk();

    await expect(MenuOrderService.createKeshlessOrder({
      eventId, buyerId: BUYER, keshlessCardNumber: '1234',
      items: [{ menuItemId: itemId, quantity: 30 }, { menuItemId: itemId, quantity: 30 }],
    })).rejects.toThrow(/50/);

    expect(await MenuOrder.countDocuments({})).toBe(0);
    expect(acceptPayment).not.toHaveBeenCalled();
  });
});
