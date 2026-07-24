import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';

describe('Event.category', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('defaults to Other', async () => {
    const e = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'A', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [] });
    expect(e.category).toBe('Other');
  });
  it('stores a valid category', async () => {
    const e = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'B', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), category: 'Music', ticketTypes: [] });
    expect(e.category).toBe('Music');
  });
});
