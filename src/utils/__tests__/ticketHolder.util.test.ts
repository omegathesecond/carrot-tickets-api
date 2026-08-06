import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { isTicketHolder, isTicketHolderForBuyer, buyerTicketOr } from '@utils/ticketHolder.util';

describe('isTicketHolder', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedTicket(eventId: string, vendorId: string, phone: string, status: TicketStatus) {
    return Ticket.create({
      eventId,
      vendorId,
      ticketType: 'General',
      price: 100,
      customerPhone: phone,
      status,
    });
  }

  it('true for a SOLD ticket, matching on normalized phone', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    await seedTicket(eventId, vendorId, '+26878422613', TicketStatus.SOLD);

    // raw local formats must still match — normalization is the contract
    expect(await isTicketHolder(eventId, '78422613')).toBe(true); // bare local form
    expect(await isTicketHolder(eventId, '078422613')).toBe(true); // trunk-0 local form
    expect(await isTicketHolder(eventId, '+268 7842 2613')).toBe(true); // spaced intl form
    expect(await isTicketHolder(eventId, '76000000')).toBe(false); // different number
  });

  it('true for CHECKED_IN (mid-festival access persists)', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    await seedTicket(eventId, vendorId, '+26878000010', TicketStatus.CHECKED_IN);
    expect(await isTicketHolder(eventId, '+26878000010')).toBe(true);
  });

  it('false for REFUNDED/CANCELLED and for other events', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    await seedTicket(eventId, vendorId, '+26878000011', TicketStatus.REFUNDED);
    expect(await isTicketHolder(eventId, '+26878000011')).toBe(false);

    const other = await seedPublishedEvent();
    await seedTicket(other.eventId, other.vendorId, '+26878000012', TicketStatus.SOLD);
    expect(await isTicketHolder(eventId, '+26878000012')).toBe(false);
  });

  it('false for empty phone', async () => {
    const { eventId } = await seedPublishedEvent();
    expect(await isTicketHolder(eventId, '')).toBe(false);
  });
});

describe('isTicketHolderForBuyer', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('true when the ticket carries the buyer\'s buyerId', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    const buyerId = new mongoose.Types.ObjectId();
    await Ticket.create({
      eventId,
      vendorId,
      ticketType: 'General',
      price: 100,
      buyerId,
      status: TicketStatus.SOLD,
    });

    const buyer = { _id: buyerId };
    expect(await isTicketHolderForBuyer(eventId, buyer)).toBe(true);
  });

  it('true for an email-only buyer matched by customerEmail', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    await Ticket.create({
      eventId,
      vendorId,
      ticketType: 'General',
      price: 100,
      customerEmail: 'buyer@example.com',
      status: TicketStatus.SOLD,
    });

    const buyer = { _id: new mongoose.Types.ObjectId(), email: 'buyer@example.com' };
    expect(await isTicketHolderForBuyer(eventId, buyer)).toBe(true);
  });

  it('false for an email-only buyer against a phone-less, unrelated-email ticket (no undefined-phone leak)', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    // Ticket has no customerPhone and an unrelated customerEmail — must NOT match.
    await Ticket.create({
      eventId,
      vendorId,
      ticketType: 'General',
      price: 100,
      customerEmail: 'someone-else@example.com',
      status: TicketStatus.SOLD,
    });

    const buyer = { _id: new mongoose.Types.ObjectId(), email: 'buyer@example.com' };
    expect(await isTicketHolderForBuyer(eventId, buyer)).toBe(false);
  });
});

describe('buyerTicketOr', () => {
  // Regression: an empty $or clause is vacuously true in Mongo — a buyer
  // with no _id/phone/email must never silently produce `[]` (which,
  // composed as `$or: []`, would match EVERY ticket document — an
  // auth-bypass, not a "no match" result). Fail loud instead.
  it('throws for a buyer with no _id, phone, or email (would otherwise produce a vacuously-true $or: [])', () => {
    expect(() => buyerTicketOr({})).toThrow(/no _id\/phone\/email/);
  });
});
