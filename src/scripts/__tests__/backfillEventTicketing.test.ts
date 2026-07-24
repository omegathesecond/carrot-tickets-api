import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { backfillEventTicketing } from '../backfillEventTicketing';

describe('backfillEventTicketing', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('sets ticketing=carrot on events missing the field', async () => {
    const e = await Event.create({ vendorId: new mongoose.Types.ObjectId(), name: 'Legacy', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), ticketTypes: [] });
    await Event.collection.updateOne({ _id: e._id }, { $unset: { ticketing: '' } });
    const res = await backfillEventTicketing();
    expect(res.updated).toBe(1);
    const reloaded = await Event.findById(e._id);
    expect(reloaded!.ticketing).toBe('carrot');
  });
});
