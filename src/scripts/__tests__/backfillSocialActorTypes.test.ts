import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Follow } from '@models/follow.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { backfillSocialActorTypes } from '../backfillSocialActorTypes';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// Insert followerType-less / actorType-less rows directly via the raw driver,
// bypassing the schema default, to mimic historical docs written before
// those fields existed.
async function legacyFollow() {
  await Follow.collection.insertOne({
    followerId: new mongoose.Types.ObjectId(),
    targetType: 'organizer',
    targetId: new mongoose.Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any);
}

async function legacyReaction() {
  await UpdateReaction.collection.insertOne({
    updateId: new mongoose.Types.ObjectId(),
    buyerId: new mongoose.Types.ObjectId(),
    type: 'like',
    createdAt: new Date(),
  } as any);
}

describe('backfillSocialActorTypes', () => {
  it('backfills legacy Follow/UpdateReaction rows and is idempotent', async () => {
    await legacyFollow();
    await legacyReaction();

    // Before backfill: the new read-path query shape does NOT match the
    // legacy rows, proving the hazard is real.
    expect(await Follow.countDocuments({ followerType: 'buyer' })).toBe(0);
    expect(await UpdateReaction.countDocuments({ actorType: 'buyer' })).toBe(0);

    const counts = await backfillSocialActorTypes();
    expect(counts.follows).toBeGreaterThanOrEqual(1);
    expect(counts.reactions).toBeGreaterThanOrEqual(1);

    // After backfill: legacy rows now carry the discriminator and match the
    // read-path query shape.
    const follow = await Follow.findOne().lean();
    expect((follow as any).followerType).toBe('buyer');
    expect(await Follow.countDocuments({ followerType: 'buyer' })).toBe(1);

    const reaction = await UpdateReaction.findOne().lean();
    expect((reaction as any).actorType).toBe('buyer');
    expect(await UpdateReaction.countDocuments({ actorType: 'buyer' })).toBe(1);

    // Idempotent: a second run touches nothing.
    const second = await backfillSocialActorTypes();
    expect(second).toEqual({ follows: 0, reactions: 0 });
  });
});
