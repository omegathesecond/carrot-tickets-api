// api/src/routes/__tests__/cashierBindTag.route.test.ts
//
// The tag desk for a cashier. Her token lives for days and authenticateCashier
// does no database lookup, so the event scope MUST be read from her row on
// every call (resolveOperatorEventScope) — never from the JWT's own eventId.
// A cashier deactivated or deleted after login resolves to [] there, and this
// route has to honour that the way top-up and cash-out already do.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { Cashier } from '@models/cashier.model';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { Wallet } from '@models/wallet.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketStatus } from '@interfaces/ticket.interface';
import { CASHIER_PERMISSIONS, CashierPermission } from '@interfaces/cashier.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const TAG = '04a22b1c';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let __loginCodeSeq = 700;

async function cashlessEvent(vendorId: mongoose.Types.ObjectId) {
  const future = new Date(Date.now() + 7 * 864e5);
  return Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future, endTime: future,
    status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
}

/** A hired cashier with the tag desk granted, her event, and a sold ticket at it. */
async function seedDesk() {
  const vendorId = new mongoose.Types.ObjectId();
  const event = await cashlessEvent(vendorId);
  const cashier = await Cashier.create({
    fullName: 'Nomsa', loginCode: `4KZ${__loginCodeSeq++}`, pin: '222222',
    scope: 'organizer', vendorId, eventId: event._id,
  });
  const ticket = await Ticket.create({
    eventId: event._id, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD,
  });
  await enrolTags(event._id, TAG);
  // Exactly the payload CashierAuthService.login mints, tag desk included.
  const token = jwt.sign({
    scope: 'cashier', userType: 'cashier', cashierId: String(cashier._id), role: 'cashier',
    permissions: [...CASHIER_PERMISSIONS, CashierPermission.ISSUE_TAGS],
    isSuperAdmin: false, fullName: 'Nomsa', vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { vendorId, event, cashier, ticket, token };
}

const bind = (token: string, ticketId: string) =>
  request(app).post('/api/cashier/bind-tag').set('Authorization', `Bearer ${token}`).send({ ticketId, bandUid: TAG });

it('lets an active, granted cashier issue a tag on her own event', async () => {
  const { ticket, token } = await seedDesk();

  const res = await bind(token, ticket.ticketId);

  expect(res.status).toBe(200);
  expect(res.body.data.wallet.bandUid).toBe(TAG);
  expect(await Wallet.countDocuments({ ticketId: ticket._id, bandUid: TAG })).toBe(1);
});

it('403s a cashier DEACTIVATED after login, whose token still has days to run', async () => {
  const { cashier, ticket, token } = await seedDesk();
  await Cashier.updateOne({ _id: cashier._id }, { $set: { isActive: false } });

  const res = await bind(token, ticket.ticketId);

  expect(res.status).toBe(403);
  expect(res.body.message).toBe('You are not assigned to this event');
  expect(await Wallet.countDocuments({ ticketId: ticket._id, bandUid: TAG })).toBe(0);
});

it('403s a cashier whose row has been DELETED, rather than freeing her', async () => {
  const { cashier, ticket, token } = await seedDesk();
  await Cashier.deleteOne({ _id: cashier._id });

  const res = await bind(token, ticket.ticketId);

  expect(res.status).toBe(403);
  expect(await Wallet.countDocuments({ ticketId: ticket._id, bandUid: TAG })).toBe(0);
});

it("refuses a ticket for another of the organizer's events — the row's event, not the token's", async () => {
  const { vendorId, ticket, token } = await seedDesk();
  const other = await cashlessEvent(vendorId);
  const foreign = await Ticket.create({
    eventId: other._id, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD,
  });
  await enrolTags(other._id, TAG);

  const res = await bind(token, foreign.ticketId);

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/not assigned/i);
  expect(await Wallet.countDocuments({ ticketId: foreign._id, bandUid: TAG })).toBe(0);
  // Her own event still works.
  expect((await bind(token, ticket.ticketId)).status).toBe(200);
});
