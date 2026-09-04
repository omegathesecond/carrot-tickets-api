import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Event } from '@models/event.model';
import { WalletService } from '@services/wallet.service';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { GateOperator } from '@models/gateOperator.model';
import mongoose from 'mongoose';

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

// requireTicketsPermission re-resolves a gate operator's permissions from
// its ROW (SCANNER role set + grants), not the token, so the token has to
// name a real, active row; the permissions it carries are informational.
let __loginCodeSeq = 100;
const gate = async (vendorId: string) => {
  const op = await GateOperator.create({
    fullName: 'Gate', loginCode: `4KW${__loginCodeSeq++}`, pin: '111111', scope: 'organizer', vendorId,
  });
  return jwt.sign({
    app: 'tickets', userType: 'gate-operator', userId: String(op._id), vendorId,
    permissions: [TicketsPermission.SCAN_TICKETS],
  }, JWT_SECRET);
};

async function seedBound(cashless = true) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless } });
  const t = await Ticket.create({ eventId, vendorId, ticketType:'General', price:100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await enrolTags(eventId, '04a22b1c3d4e5f', 'bbbbbbbbbbbbbb');
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');
  return { eventId: String(eventId), vendorId: String(vendorId), ticketId: t.ticketId };
}

it('checks in by band uid on a cashless event', async () => {
  const { eventId, vendorId } = await seedBound(true);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${await gate(vendorId)}`)
    .send({ bandUid: '04a22b1c3d4e5f', expectedEventId: eventId });
  expect(res.status).toBe(200);
});

it('rejects band check-in when the event is not cashless', async () => {
  const { eventId, vendorId } = await seedBound(false);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${await gate(vendorId)}`)
    .send({ bandUid: '04a22b1c3d4e5f', expectedEventId: eventId });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cashless/i);
});

it('rejects an unbound uid with 400', async () => {
  const { eventId, vendorId } = await seedBound(true);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${await gate(vendorId)}`)
    .send({ bandUid: 'bbbbbbbbbbbbbb', expectedEventId: eventId });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/no wallet|not bound|no band/i);
});

// FIX 3 (cross-tenant check-in): an operator from a DIFFERENT vendor scanning a
// band bound at this vendor's event is rejected with 403 BEFORE any band/wallet
// lookup — so it never leaks whether the band/event exists. The message must be
// the vendor-ownership rejection, not a band-existence hint.
it('rejects cross-vendor band check-in with 403 before leaking existence', async () => {
  const { eventId } = await seedBound(true); // band bound under the seeded (Vendor B) event
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${await gate(String(new mongoose.Types.ObjectId()))}`)
    .send({ bandUid: '04a22b1c3d4e5f', expectedEventId: eventId });
  expect(res.status).toBe(403);
  expect(res.body.message).toMatch(/different vendor/i);
});
