/**
 * Tasks 4 & 5: ticket.card.test.ts
 * Tests initiateCardPurchase (Task 4) and finalizeCardSale (Task 5) using
 * in-memory Mongo + a module-level mock of PeachClient.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
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
  process.env['CARD_RESULT_URL'] = 'https://carrot.test/result';
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

// ── Helper: seed a PENDING card sale with a reservation ─────────────────────
async function seedPendingCardSale(overrides?: { paymentStatus?: PaymentStatus }) {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Finalize Card Concert',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      {
        name: 'General',
        price: 50,
        quantity: 10,
        sold: 0,
        reserved: 1, // already reserved by the initiation step
      },
    ],
  });

  const ticketTypeId = event.ticketTypes[0]!._id!.toString();

  const sale = await TicketSale.create({
    eventId: event._id,
    vendorId,
    ticketIds: [],
    quantity: 1,
    customerName: 'Test Buyer',
    customerPhone: '+26878422613',
    totalAmount: 50,
    paymentMethod: PaymentMethod.CARD,
    paymentStatus: overrides?.paymentStatus ?? PaymentStatus.PENDING,
    peachPaymentId: 'pay_finalize',
    soldBy: vendorId,
    soldByType: 'Vendor',
    channel: 'box_office',
    faceAmount: 50,
    platformFeeAmount: 0,
    organizerProceeds: 50,
    resellerCommission: 0,
    fundsCustody: 'carrot',
    soldAt: new Date(),
    // reservationExpiresAt omitted — not required for finalize tests
  });

  // Seed a TicketReservation so finalizeSale can find ticketTypeId
  const { TicketReservation } = await import('@models/ticketReservation.model');
  await TicketReservation.create({
    eventId: event._id,
    ticketTypeId,
    quantity: 1,
    saleId: sale._id.toString(),
    expiresAt: new Date(Date.now() + 15 * 60_000),
    status: 'held',
  });

  return { event, sale, ticketTypeId, vendorId };
}

describe('finalizeCardSale', () => {
  beforeEach(() => {
    process.env['CARD_CURRENCY'] = 'ZAR';
  });

  it('returns pending when result code is 000.200.000', async () => {
    await seedPendingCardSale();

    getPaymentStatus.mockResolvedValue({ code: '000.200.000', amount: '50.00', currency: 'ZAR' });

    const result = await TicketService.finalizeCardSale('pay_finalize');
    expect(result.status).toBe('pending');

    // No tickets minted
    const tickets = await Ticket.find({});
    expect(tickets.length).toBe(0);
  });

  it('releases reservation and sets sale FAILED when code is rejected (800.100.151)', async () => {
    const { event } = await seedPendingCardSale();

    getPaymentStatus.mockResolvedValue({ code: '800.100.151', amount: '50.00', currency: 'ZAR' });

    const result = await TicketService.finalizeCardSale('pay_finalize');
    expect(result.status).toBe('failed');

    const sale = await TicketSale.findOne({ peachPaymentId: 'pay_finalize' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

    // Reservation released: reserved count goes back to 0
    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0);

    // No tickets minted
    const tickets = await Ticket.find({});
    expect(tickets.length).toBe(0);
  });

  it('mints tickets and returns completed on success (000.000.000, amount "50.00", ZAR)', async () => {
    const { event } = await seedPendingCardSale();

    // amount returned as STRING "50.00"; totalAmount on sale is NUMBER 50
    // Number('50.00') === 50 → guard passes
    getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '50.00', currency: 'ZAR' });

    const result = await TicketService.finalizeCardSale('pay_finalize');
    expect(result.status).toBe('completed');

    const sale = await TicketSale.findOne({ peachPaymentId: 'pay_finalize' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale!.ticketIds.length).toBe(1);

    // One ticket minted
    const tickets = await Ticket.find({});
    expect(tickets.length).toBe(1);

    // Event sold count updated (reserved→sold)
    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.sold).toBe(1);
  });

  it('fails and does NOT mint when amount or currency mismatches (amount "10.00" vs totalAmount 50)', async () => {
    const { event } = await seedPendingCardSale();

    // success code but wrong amount → guard must reject
    getPaymentStatus.mockResolvedValue({ code: '000.000.000', amount: '10.00', currency: 'ZAR' });

    const result = await TicketService.finalizeCardSale('pay_finalize');
    expect(result.status).toBe('failed');

    const sale = await TicketSale.findOne({ peachPaymentId: 'pay_finalize' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

    // No tickets minted
    const tickets = await Ticket.find({});
    expect(tickets.length).toBe(0);

    // Reservation released
    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0);
  });

  it('returns completed without re-minting when sale is already COMPLETED (idempotent)', async () => {
    await seedPendingCardSale({ paymentStatus: PaymentStatus.COMPLETED });

    // getPaymentStatus should NOT be called at all
    const result = await TicketService.finalizeCardSale('pay_finalize');
    expect(result.status).toBe('completed');

    expect(getPaymentStatus).not.toHaveBeenCalled();

    // Still no tickets (they weren't minted by the helper)
    const tickets = await Ticket.find({});
    expect(tickets.length).toBe(0);
  });
});
