import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import mongoose from 'mongoose';

describe('Update model', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a buyer video update in processing state with zeroed counters', async () => {
    const u = await Update.create({
      authorType: 'buyer',
      authorId: new mongoose.Types.ObjectId(),
      kind: 'video',
      caption: 'first clip',
      media: { rawKey: 'updates/raw/123-clip.mov', status: 'processing' },
    });
    expect(u.media.status).toBe('processing');
    expect(u.likeCount).toBe(0);
    expect(u.saveCount).toBe(0);
    expect(u.shareCount).toBe(0);
    expect(u.status).toBe('active');
  });

  it('rejects an invalid authorType', async () => {
    await expect(
      Update.create({ authorType: 'admin' as any, authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: '', media: { rawKey: 'k', status: 'ready' } }),
    ).rejects.toThrow();
  });

  it('rejects a caption over 500 chars', async () => {
    await expect(
      Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: 'x'.repeat(501), media: { rawKey: 'k', status: 'ready' } }),
    ).rejects.toThrow();
  });
});
