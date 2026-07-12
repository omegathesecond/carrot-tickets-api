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
});
