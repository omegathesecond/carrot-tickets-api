import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';

describe('Event.ticketing', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('defaults to carrot', async () => {
    const e = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'A', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [{ name: 'GA', price: 10, quantity: 5, available: 5 }] });
    expect(e.ticketing).toBe('carrot');
    expect(e.externalTicketUrl).toBeUndefined();
  });

  it('stores an external mode + url', async () => {
    const e = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'B', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketing: 'external', externalTicketUrl: 'https://my.tickets/b' });
    expect(e.ticketing).toBe('external');
    expect(e.externalTicketUrl).toBe('https://my.tickets/b');
  });
});
