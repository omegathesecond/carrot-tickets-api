import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { migrateLegacyEventCategories } from '../migrateLegacyEventCategories';

describe('migrateLegacyEventCategories', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const baseFields = () => ({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Legacy',
    venue: 'V',
    eventDate: new Date(),
    startTime: new Date(),
    endTime: new Date(),
    ticketTypes: [],
  });

  it('remaps an unambiguous legacy label to its new category id', async () => {
    const e = await Event.create(baseFields());
    await Event.collection.updateOne({ _id: e._id }, { $set: { category: 'Food' } });
    const res = await migrateLegacyEventCategories();
    expect(res.updated).toBe(1);
    const reloaded = await Event.findById(e._id);
    expect(reloaded!.category).toBe('food-hospitality');
  });

  it('falls back ambiguous legacy labels (e.g. Music, old Other) to the default category', async () => {
    const music = await Event.create(baseFields());
    await Event.collection.updateOne({ _id: music._id }, { $set: { category: 'Music' } });
    const other = await Event.create(baseFields());
    await Event.collection.updateOne({ _id: other._id }, { $set: { category: 'Other' } });

    const res = await migrateLegacyEventCategories();
    expect(res.updated).toBe(2);

    expect((await Event.findById(music._id))!.category).toBe('events');
    expect((await Event.findById(other._id))!.category).toBe('events');
  });

  it('leaves an event already on the new taxonomy untouched', async () => {
    const e = await Event.create({ ...baseFields(), category: 'sports' });
    const res = await migrateLegacyEventCategories();
    expect(res.updated).toBe(0);
    expect((await Event.findById(e._id))!.category).toBe('sports');
  });

  it('is idempotent — a second run makes no further changes', async () => {
    const e = await Event.create(baseFields());
    await Event.collection.updateOne({ _id: e._id }, { $set: { category: 'Film' } });
    await migrateLegacyEventCategories();
    const res = await migrateLegacyEventCategories();
    expect(res.updated).toBe(0);
    expect((await Event.findById(e._id))!.category).toBe('cinema-theatre');
  });
});
