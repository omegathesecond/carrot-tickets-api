// api/src/utils/__tests__/ticketLookup.util.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Ticket } from '@models/ticket.model';
import { findTicketByCode } from '@utils/ticketLookup.util';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const base = () => ({ eventId: new mongoose.Types.ObjectId(), vendorId: new mongoose.Types.ObjectId(), ticketType: 'General', price: 100 });

it('finds a new short code typed with a dash and lowercase', async () => {
  const t = await Ticket.create({ ...base(), ticketId: 'K7P29XQR' });
  const found = await findTicketByCode('k7p2-9xqr');
  expect(found?._id.toString()).toBe(t._id.toString());
});

it('finds a legacy TKT id by exact match', async () => {
  const t = await Ticket.create({ ...base(), ticketId: 'TKT-123-AB3D9F' });
  const found = await findTicketByCode('TKT-123-AB3D9F');
  expect(found?._id.toString()).toBe(t._id.toString());
});

it('returns null for an unknown code', async () => {
  expect(await findTicketByCode('ZZZZZZZZ')).toBeNull();
});
