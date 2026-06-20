/**
 * Task 6: momoSale.test.ts
 * Tests initiateMomoPurchase and finalizeMomoSale using in-memory Mongo +
 * a module-level mock of MtnMomoClient so both the static TicketService.momoClient
 * and MtnMomoProcessor use the same mock instance.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

// ── Mock MtnMomoClient BEFORE importing TicketService ──────────────────────
// Mocking the module means every `new MtnMomoClient()` (in processor AND the
// static TicketService.momoClient) returns the same mocked instance, so both
// paths hit our controlled stub.
//
// We use a manual factory mock: the constructor returns a single shared mockInstance
// object, so the static `TicketService.momoClient` and any later `new MtnMomoClient()`
// inside MtnMomoProcessor all point to the same mock.
const mockMomoInstance = {
  isConfigured: jest.fn(),
  requestToPay: jest.fn(),
  getStatus: jest.fn(),
};

jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => mockMomoInstance),
}));

import { TicketService } from '@services/ticket.service';

beforeAll(async () => {
  await connectTestDb();
});

afterEach(async () => {
  await clearTestDb();
  mockMomoInstance.isConfigured.mockReset();
  mockMomoInstance.requestToPay.mockReset();
  mockMomoInstance.getStatus.mockReset();
});

afterAll(async () => {
  await disconnectTestDb();
});

// ── Seed helpers ────────────────────────────────────────────────────────────
async function seedPublishedEvent() {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'MoMo Test Concert',
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TicketService.initiateMomoPurchase', () => {
  it('creates a PENDING sale + reservation and no tickets when requestToPay succeeds', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    // MtnMomoClient is mocked at module level; configure stubs on the shared mock instance
    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R1' });

    const result = await TicketService.initiateMomoPurchase({
      eventId,
      ticketTypeId,
      quantity: 2,
      customerPhone: '+26876111111',
      momoPhone: '26876111111',
    });

    expect(result.referenceId).toBe('R1');
    expect(result.saleId).toBeTruthy();
    expect(result.expiresAt).toBeInstanceOf(Date);

    // Sale must be PENDING with no tickets minted
    const sale = await TicketSale.findOne({ momoReferenceId: 'R1' });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(sale!.ticketIds.length).toBe(0);

    // Event reserved count must be 2
    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(2);
    expect(tt.available).toBe(8); // 10 - 0 sold - 2 reserved
  });

  it('releases reservation and sets sale FAILED when requestToPay throws', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockRejectedValue(new Error('MoMo down'));

    await expect(
      TicketService.initiateMomoPurchase({
        eventId,
        ticketTypeId,
        quantity: 2,
        customerPhone: '+26876111111',
        momoPhone: '26876111111',
      })
    ).rejects.toThrow('MoMo down');

    // Sale should be FAILED, reservation released
    const sale = await TicketSale.findOne({ paymentMethod: PaymentMethod.MTN_MOMO });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0); // released
  });
});

describe('TicketService.finalizeMomoSale', () => {
  it('mints tickets + completes sale when MTN status is SUCCESSFUL (and is idempotent)', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R1' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: {} });

    // Initiate first
    await TicketService.initiateMomoPurchase({
      eventId,
      ticketTypeId,
      quantity: 2,
      customerPhone: '+26876111111',
      momoPhone: '26876111111',
    });

    // Finalize — first call should complete
    const first = await TicketService.finalizeMomoSale('R1');
    expect(first.status).toBe('completed');

    // Verify sale completed + tickets minted
    const sale = await TicketSale.findOne({ momoReferenceId: 'R1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale!.ticketIds.length).toBe(2);

    // Verify sold incremented, reserved released
    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0);
    expect(tt.sold).toBe(2);

    // Second call — idempotent, no-op, still returns 'completed'
    const second = await TicketService.finalizeMomoSale('R1');
    expect(second.status).toBe('completed');

    // Verify no duplicate tickets were minted
    const ticketCount = await Ticket.countDocuments({ eventId });
    expect(ticketCount).toBe(2);
  });

  it('releases reservation + fails the sale when MTN status is FAILED', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R2' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'FAILED', raw: {} });

    await TicketService.initiateMomoPurchase({
      eventId,
      ticketTypeId,
      quantity: 2,
      customerPhone: '+26876222222',
      momoPhone: '26876222222',
    });

    const result = await TicketService.finalizeMomoSale('R2');
    expect(result.status).toBe('failed');

    const sale = await TicketSale.findOne({ momoReferenceId: 'R2' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(sale!.ticketIds.length).toBe(0);

    // reserved back to 0
    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0);
    expect(tt.sold).toBe(0);
    expect(tt.available).toBe(10);
  });

  it('returns pending when MTN status is still PENDING', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R3' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'PENDING', raw: {} });

    await TicketService.initiateMomoPurchase({
      eventId,
      ticketTypeId,
      quantity: 1,
      customerPhone: '+26876333333',
      momoPhone: '26876333333',
    });

    const result = await TicketService.finalizeMomoSale('R3');
    expect(result.status).toBe('pending');

    // Sale must still be PENDING
    const sale = await TicketSale.findOne({ momoReferenceId: 'R3' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(sale!.ticketIds.length).toBe(0);
  });
});
