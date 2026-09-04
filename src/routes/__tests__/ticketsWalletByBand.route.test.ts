import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { WalletService } from '@services/wallet.service';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { signVendorToken } from '@/__tests__/helpers/auth';
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

it('returns the wallet view for a bound band', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  const t = await Ticket.create({ eventId, vendorId, ticketType:'General', price:100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await enrolTags(eventId, '04a22b1c3d4e5f');
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');

  const res = await request(app).get(`/api/tickets/wallets/by-band/04a22b1c3d4e5f?eventId=${eventId}`)
    .set('Authorization', `Bearer ${await gate(String(vendorId))}`);
  expect(res.status).toBe(200);
  expect(res.body.data.status).toBe('active');
  expect(res.body.data.balance).toBe(0);
});

it('404s an unbound uid', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({});
  const res = await request(app).get(`/api/tickets/wallets/by-band/aaaaaaaaaaaaaa?eventId=${eventId}`)
    .set('Authorization', `Bearer ${await gate(String(vendorId))}`);
  expect(res.status).toBe(404);
});

it('403 without SCAN_TICKETS', async () => {
  const { eventId } = await seedPublishedEvent({});
  const res = await request(app).get(`/api/tickets/wallets/by-band/aaaaaaaaaaaaaa?eventId=${eventId}`)
    .set('Authorization', `Bearer ${signVendorToken(String(new mongoose.Types.ObjectId()), { permissions: [TicketsPermission.VIEW_EVENTS] })}`);
  expect(res.status).toBe(403);
});

// FIX 2 (vendor-ownership): an operator whose token vendorId is Vendor A must
// NOT be able to read a band at Vendor B's event — even with SCAN_TICKETS and a
// real bound band. Without the guard this returned 200 with B's wallet data.
it('rejects Vendor A reading Vendor B\'s event band with 403 (no wallet leak)', async () => {
  const { eventId, vendorId } = await seedPublishedEvent({}); // vendorId = Vendor B
  const t = await Ticket.create({ eventId, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await enrolTags(eventId, '04a22b1c3d4e5f');
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');

  const res = await request(app).get(`/api/tickets/wallets/by-band/04a22b1c3d4e5f?eventId=${eventId}`)
    .set('Authorization', `Bearer ${await gate(String(new mongoose.Types.ObjectId()))}`);
  expect(res.status).toBe(403);
  expect(res.body.data).toBeUndefined();
});
