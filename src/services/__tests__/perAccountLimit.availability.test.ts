import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventService } from '../event.service';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketStatus } from '@interfaces/ticket.interface';
import { normalizePhone } from '@utils/phone.util';
import mongoose from 'mongoose';

const DAY = 86400000;

async function seedCapEvent(cap?: number) {
  const vendor = await Vendor.create({ businessName: 'Org', password: 'password123', slug: 'org-cap2' });
  const event = await Event.create({
    vendorId: vendor._id,
    name: 'Legends Cup',
    venue: 'V',
    eventDate: new Date(Date.now() + DAY),
    startTime: new Date(Date.now() + DAY),
    endTime: new Date(Date.now() + DAY + 3600000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'GA', price: 100, quantity: 999, sold: 0 }],
    ...(cap ? { maxTicketsPerAccount: cap } : {}),
  });
  return { vendor, event, ticketTypeId: String(event.ticketTypes[0]!._id) };
}

async function giveTicket(
  eventId: string,
  vendorId: string,
  who: { buyerId?: string; customerPhone?: string; status?: TicketStatus },
) {
  return Ticket.create({
    eventId,
    vendorId,
    ticketType: 'GA',
    price: 100,
    buyerId: who.buyerId,
    customerPhone: who.customerPhone,
    status: who.status ?? TicketStatus.SOLD,
  });
}

describe('checkTicketAvailability — per-account cap', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('allows the first ticket for a limit-1 event', async () => {
    const { event, ticketTypeId } = await seedCapEvent(1);
    const buyerId = new mongoose.Types.ObjectId().toString();
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { buyerId });
    expect(r.available).toBe(true);
  });

  it('blocks a second ticket by the same buyerId', async () => {
    const { event, vendor, ticketTypeId } = await seedCapEvent(1);
    const buyerId = new mongoose.Types.ObjectId().toString();
    await giveTicket(String(event._id), String(vendor._id), { buyerId });
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { buyerId });
    expect(r.available).toBe(false);
    expect(r.message).toMatch(/one per person/i);
  });

  it('blocks buying 2 in a single order for a limit-1 event', async () => {
    const { event, ticketTypeId } = await seedCapEvent(1);
    const buyerId = new mongoose.Types.ObjectId().toString();
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 2, undefined, { buyerId });
    expect(r.available).toBe(false);
  });

  it('matches on normalized phone when there is no buyerId', async () => {
    const { event, vendor, ticketTypeId } = await seedCapEvent(1);
    // Real tickets store the NORMALIZED phone (buildTicket normalizes at issue),
    // so seed the normalized form; the gate normalizes the query phone before
    // matching. Querying with a bare local form must still hit the same record.
    await giveTicket(String(event._id), String(vendor._id), { customerPhone: normalizePhone('76000001') });
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { phone: '76000001' });
    expect(r.available).toBe(false);
  });

  it('does NOT count refunded/cancelled tickets', async () => {
    const { event, vendor, ticketTypeId } = await seedCapEvent(1);
    const buyerId = new mongoose.Types.ObjectId().toString();
    await giveTicket(String(event._id), String(vendor._id), { buyerId, status: TicketStatus.REFUNDED });
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { buyerId });
    expect(r.available).toBe(true);
  });

  it('is skipped when no cap is set (a buyer with 5 tickets can buy more)', async () => {
    const { event, vendor, ticketTypeId } = await seedCapEvent(undefined);
    const buyerId = new mongoose.Types.ObjectId().toString();
    for (let i = 0; i < 5; i++) await giveTicket(String(event._id), String(vendor._id), { buyerId });
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1, undefined, { buyerId });
    expect(r.available).toBe(true);
  });

  it('is skipped when no buyer identity is supplied (POS walk-up)', async () => {
    const { event, ticketTypeId } = await seedCapEvent(1);
    const r = await EventService.checkTicketAvailability(String(event._id), ticketTypeId, 1);
    expect(r.available).toBe(true);
  });
});
