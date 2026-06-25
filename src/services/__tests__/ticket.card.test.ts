/**
 * Task 4: ticket.card.test.ts
 * Tests initiateCardPurchase using in-memory Mongo + a module-level mock of
 * PeachClient, mirroring the momo test scaffold exactly so behaviour is consistent.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

// ── Mock PeachClient BEFORE importing TicketService ───────────────────────────
// Same pattern as MtnMomoClient mock in momoSale.test.ts: every `new PeachClient()`
// in TicketService (static field) returns the same shared mock instance.
const createPayment = jest.fn();
const getPaymentStatus = jest.fn();

jest.mock('@services/payments/peach.client', () => ({
  classifyResultCode: jest.requireActual('@services/payments/peach.client').classifyResultCode,
  PeachClient: jest.fn().mockImplementation(() => ({ isConfigured: () => true, createPayment, getPaymentStatus })),
  __mock: { createPayment, getPaymentStatus },
}));

import { TicketService } from '@services/ticket.service';

beforeAll(async () => {
  await connectTestDb();
});

afterEach(async () => {
  await clearTestDb();
  createPayment.mockReset();
  getPaymentStatus.mockReset();
});

afterAll(async () => {
  await disconnectTestDb();
});

// ── Seed helpers ─────────────────────────────────────────────────────────────
async function seedPublishedEvent() {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Card Test Concert',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      {
        name: 'General',
        price: 100,
        quantity: 10,
        sold: 0,
        reserved: 0,
      },
    ],
  });

  const ticketTypeId = event.ticketTypes[0]!._id!.toString();
  return { event, ticketTypeId, vendorId, eventId: event._id.toString() };
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('initiateCardPurchase', () => {
  it('creates PENDING card sale, reserves, returns paymentId+redirect', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    createPayment.mockResolvedValue({
      id: 'pay_1',
      code: '000.200.000',
      redirect: { url: 'https://peach/pay', method: 'GET' },
    });

    const r = await TicketService.initiateCardPurchase({
      eventId,
      ticketTypeId,
      quantity: 1,
      customerPhone: '+26878422613',
    } as any);

    expect(r.paymentId).toBeDefined();
    expect(r.redirect).toBeDefined();
    expect(r.saleId).toBeDefined();

    // Sale must be PENDING with no tickets minted
    const sale = await TicketSale.findOne({ peachPaymentId: 'pay_1' });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(sale!.ticketIds.length).toBe(0);
    expect(sale!.paymentMethod).toBe(PaymentMethod.CARD);

    // Event reserved count must be 1
    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(1);
    expect(tt.available).toBe(9); // 10 - 0 sold - 1 reserved
  });

  it('releases reservation and sets sale FAILED when createPayment throws', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    createPayment.mockRejectedValue(new Error('Peach down'));

    await expect(
      TicketService.initiateCardPurchase({
        eventId,
        ticketTypeId,
        quantity: 1,
        customerPhone: '+26878422613',
      } as any),
    ).rejects.toThrow('Peach down');

    // Sale should be FAILED, reservation released
    const sale = await TicketSale.findOne({ paymentMethod: PaymentMethod.CARD });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0); // released
  });

  it('getCardSaleByPaymentId returns the sale by peachPaymentId', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    createPayment.mockResolvedValue({
      id: 'pay_lookup',
      code: '000.200.000',
      redirect: { url: 'https://peach/pay', method: 'GET' },
    });

    await TicketService.initiateCardPurchase({
      eventId,
      ticketTypeId,
      quantity: 1,
      customerPhone: '+26878422613',
    } as any);

    const found = await TicketService.getCardSaleByPaymentId('pay_lookup');
    expect(found).not.toBeNull();
    expect(found!.peachPaymentId).toBe('pay_lookup');
    expect(found!.paymentMethod).toBe(PaymentMethod.CARD);
  });
});
