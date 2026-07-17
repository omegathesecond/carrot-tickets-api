import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventReaction } from '@models/eventReaction.model';

describe('EventReaction', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const ids = () => ({
    eventId: new mongoose.Types.ObjectId(),
    buyerId: new mongoose.Types.ObjectId(),
  });

  it('defaults actorType to buyer', async () => {
    await EventReaction.init();
    const { eventId, buyerId } = ids();
    const r = await EventReaction.create({ eventId, buyerId, type: 'like' });
    expect(r.actorType).toBe('buyer');
  });

  it('rejects a duplicate like from the same actor on the same event', async () => {
    await EventReaction.init();
    const { eventId, buyerId } = ids();
    await EventReaction.create({ eventId, buyerId, actorType: 'buyer', type: 'like' });
    await expect(
      EventReaction.create({ eventId, buyerId, actorType: 'buyer', type: 'like' })
    ).rejects.toThrow();
  });

  it('lets a buyer and a vendor sharing an id value both like the same event', async () => {
    await EventReaction.init();
    const { eventId, buyerId } = ids();
    await EventReaction.create({ eventId, buyerId, actorType: 'buyer', type: 'like' });
    const asVendor = await EventReaction.create({ eventId, buyerId, actorType: 'vendor', type: 'like' });
    expect(asVendor.actorType).toBe('vendor');
    expect(await EventReaction.countDocuments({ eventId })).toBe(2);
  });
});
