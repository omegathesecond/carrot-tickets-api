// api/src/models/__tests__/ticketCode.model.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Ticket } from '@models/ticket.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const baseTicket = () => ({
  eventId: new mongoose.Types.ObjectId(),
  vendorId: new mongoose.Types.ObjectId(),
  ticketType: 'General',
  price: 100,
});

it('assigns an 8-char unambiguous ticketId on create', async () => {
  const t = await Ticket.create(baseTicket());
  expect(t.ticketId).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
});

it('does not overwrite an explicitly provided ticketId', async () => {
  const t = await Ticket.create({ ...baseTicket(), ticketId: 'TKT-LEGACY-1' });
  expect(t.ticketId).toBe('TKT-LEGACY-1');
});

it('generates distinct codes across many tickets', async () => {
  const docs = await Promise.all(Array.from({ length: 50 }, () => Ticket.create(baseTicket())));
  const codes = new Set(docs.map((d) => d.ticketId));
  expect(codes.size).toBe(50);
});
