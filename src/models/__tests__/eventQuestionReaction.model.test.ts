import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { EventQuestionReaction } from '@models/eventQuestionReaction.model';

describe('EventQuestionReaction', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const ids = () => ({
    questionId: new mongoose.Types.ObjectId(),
    buyerId: new mongoose.Types.ObjectId(),
  });

  it('defaults actorType to buyer', async () => {
    await EventQuestionReaction.init();
    const { questionId, buyerId } = ids();
    const r = await EventQuestionReaction.create({ questionId, buyerId, type: 'like' });
    expect(r.actorType).toBe('buyer');
  });

  it('rejects a duplicate like from the same actor on the same question', async () => {
    await EventQuestionReaction.init();
    const { questionId, buyerId } = ids();
    await EventQuestionReaction.create({ questionId, buyerId, actorType: 'buyer', type: 'like' });
    await expect(
      EventQuestionReaction.create({ questionId, buyerId, actorType: 'buyer', type: 'like' }),
    ).rejects.toThrow();
  });

  it('lets a buyer and a vendor sharing an id value both like the same question', async () => {
    await EventQuestionReaction.init();
    const { questionId, buyerId } = ids();
    await EventQuestionReaction.create({ questionId, buyerId, actorType: 'buyer', type: 'like' });
    const asVendor = await EventQuestionReaction.create({ questionId, buyerId, actorType: 'vendor', type: 'like' });
    expect(asVendor.actorType).toBe('vendor');
    expect(await EventQuestionReaction.countDocuments({ questionId })).toBe(2);
  });
});
