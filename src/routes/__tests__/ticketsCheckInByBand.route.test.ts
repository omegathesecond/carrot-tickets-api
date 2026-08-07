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

beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);
const gate = (vendorId: string) => jwt.sign(
  { app:'tickets', userType:'gate-operator', vendorId, permissions:[TicketsPermission.SCAN_TICKETS] }, JWT_SECRET);

async function seedBound(cashless = true) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless } });
  const t = await Ticket.create({ eventId, vendorId, ticketType:'General', price:100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');
  return { eventId: String(eventId), vendorId: String(vendorId), ticketId: t.ticketId };
}

it('checks in by band uid on a cashless event', async () => {
  const { eventId, vendorId } = await seedBound(true);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${gate(vendorId)}`)
    .send({ bandUid: '04a22b1c3d4e5f', expectedEventId: eventId });
  expect(res.status).toBe(200);
});

it('rejects band check-in when the event is not cashless', async () => {
  const { eventId, vendorId } = await seedBound(false);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${gate(vendorId)}`)
    .send({ bandUid: '04a22b1c3d4e5f', expectedEventId: eventId });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cashless/i);
});

it('404s an unbound uid', async () => {
  const { eventId, vendorId } = await seedBound(true);
  const res = await request(app).post('/api/tickets/scans/check-in')
    .set('Authorization', `Bearer ${gate(vendorId)}`)
    .send({ bandUid: 'bbbbbbbbbbbbbb', expectedEventId: eventId });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/no wallet|not bound|no band/i);
});
