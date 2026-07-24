import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import { backfillUpdateHashtags } from '../backfillUpdateHashtags';

describe('backfillUpdateHashtags', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const baseUpdate = {
    authorType: 'buyer' as const,
    authorId: new mongoose.Types.ObjectId(),
    kind: 'image' as const,
    media: { rawKey: 'updates/raw/1.jpg', status: 'ready' as const },
  };

  it('derives hashtags per-doc from caption for updates missing/empty hashtags', async () => {
    const u = await Update.create({ ...baseUpdate, caption: 'Live now #Music #art' });
    // simulate a pre-migration doc that predates the hashtags field
    await Update.collection.updateOne({ _id: u._id }, { $unset: { hashtags: '' } });

    const res = await backfillUpdateHashtags();

    expect(res.updated).toBe(1);
    const reloaded = await Update.findById(u._id);
    expect(reloaded!.hashtags).toEqual(['music', 'art']);
  });

  it('is idempotent — a second run updates nothing further', async () => {
    const u = await Update.create({ ...baseUpdate, caption: '#Music #art' });
    await Update.collection.updateOne({ _id: u._id }, { $unset: { hashtags: '' } });

    await backfillUpdateHashtags();
    const second = await backfillUpdateHashtags();

    expect(second.updated).toBe(0);
    const reloaded = await Update.findById(u._id);
    expect(reloaded!.hashtags).toEqual(['music', 'art']);
  });

  it('skips updates whose caption has no hashtag', async () => {
    const u = await Update.create({ ...baseUpdate, caption: 'just a caption' });
    await Update.collection.updateOne({ _id: u._id }, { $unset: { hashtags: '' } });

    const res = await backfillUpdateHashtags();

    expect(res.updated).toBe(0);
    const reloaded = await Update.findById(u._id);
    expect(reloaded!.hashtags).toEqual([]);
  });

  it('leaves updates that already have hashtags untouched', async () => {
    const u = await Update.create({ ...baseUpdate, caption: '#Music', hashtags: ['music'] });

    const res = await backfillUpdateHashtags();

    expect(res.updated).toBe(0);
    const reloaded = await Update.findById(u._id);
    expect(reloaded!.hashtags).toEqual(['music']);
  });
});
