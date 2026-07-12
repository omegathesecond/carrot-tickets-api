import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import { reconcileStuckUpdates } from '@services/transcode.client';
import mongoose from 'mongoose';

describe('reconcileStuckUpdates', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('marks a >30min-stuck processing video as failed (fail-loud)', async () => {
    const u = await Update.create({
      authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'video', caption: '',
      media: { rawKey: 'k', status: 'processing', processingStartedAt: new Date(Date.now() - 31 * 60000) },
    });
    await reconcileStuckUpdates();
    const after = await Update.findById(u.id);
    expect(after!.media.status).toBe('failed');
    expect(after!.media.error).toBeTruthy();
  });

  it('leaves a fresh processing update alone', async () => {
    const u = await Update.create({
      authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'video', caption: '',
      media: { rawKey: 'k', status: 'processing', processingStartedAt: new Date() },
    });
    await reconcileStuckUpdates();
    const after = await Update.findById(u.id);
    expect(after!.media.status).toBe('processing');
  });
});
