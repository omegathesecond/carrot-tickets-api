import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { UpdateReaction } from '@models/updateReaction.model';
import mongoose from 'mongoose';

describe('UpdateReaction model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('enforces one reaction per (update, buyer, type)', async () => {
    const updateId = new mongoose.Types.ObjectId();
    const buyerId = new mongoose.Types.ObjectId();
    await UpdateReaction.init();
    await UpdateReaction.create({ updateId, buyerId, type: 'like' });
    await expect(UpdateReaction.create({ updateId, buyerId, type: 'like' })).rejects.toThrow();
    // a different type is allowed
    await expect(UpdateReaction.create({ updateId, buyerId, type: 'save' })).resolves.toBeTruthy();
  });

  it('allows a buyer and a vendor with the SAME id to react to the same update once each', async () => {
    await UpdateReaction.init();
    const updateId = new mongoose.Types.ObjectId();
    const sharedId = new mongoose.Types.ObjectId(); // astronomically unlikely IRL, but the unique key must permit it
    await UpdateReaction.create({ updateId, buyerId: sharedId, actorType: 'buyer', type: 'like' });
    await UpdateReaction.create({ updateId, buyerId: sharedId, actorType: 'vendor', type: 'like' });
    expect(await UpdateReaction.countDocuments({ updateId })).toBe(2);
  });

  it('rejects a duplicate reaction from the same actor', async () => {
    await UpdateReaction.init();
    const updateId = new mongoose.Types.ObjectId();
    const buyerId = new mongoose.Types.ObjectId();
    await UpdateReaction.create({ updateId, buyerId, actorType: 'vendor', type: 'like' });
    await expect(
      UpdateReaction.create({ updateId, buyerId, actorType: 'vendor', type: 'like' })
    ).rejects.toMatchObject({ code: 11000 });
  });
});
