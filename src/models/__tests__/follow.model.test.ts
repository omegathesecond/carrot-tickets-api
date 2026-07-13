import mongoose from 'mongoose';
import { Follow } from '@models/follow.model';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

describe('Follow model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('defaults followerType to "buyer" (back-compat)', async () => {
    const f = await Follow.create({
      followerId: new mongoose.Types.ObjectId(),
      targetType: 'organizer',
      targetId: new mongoose.Types.ObjectId(),
    });
    expect(f.followerType).toBe('buyer');
  });

  it('allows a buyer and a vendor with the SAME id to follow the same target once each', async () => {
    await Follow.init();
    const followerId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'buyer', followerId, targetType: 'organizer', targetId });
    await Follow.create({ followerType: 'vendor', followerId, targetType: 'organizer', targetId });
    expect(await Follow.countDocuments({ targetId })).toBe(2);
  });

  it('rejects a duplicate follow from the same follower', async () => {
    await Follow.init();
    const followerId = new mongoose.Types.ObjectId();
    const targetId = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'vendor', followerId, targetType: 'organizer', targetId });
    await expect(
      Follow.create({ followerType: 'vendor', followerId, targetType: 'organizer', targetId })
    ).rejects.toMatchObject({ code: 11000 });
  });
});
