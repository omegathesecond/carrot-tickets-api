import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { createUpdate, finalizeUpdate, getUpdate } from '@services/update.service';
import { Update } from '@models/update.model';
import mongoose from 'mongoose';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
const mockTriggerTranscode = jest.fn().mockResolvedValue(undefined);
jest.mock('@services/transcode.client', () => ({ triggerTranscode: (...a: any[]) => mockTriggerTranscode(...a), reconcileStuckUpdates: jest.fn() }));

describe('update.service', () => {
  beforeAll(connectTestDb);
  afterEach(async () => { await clearTestDb(); mockTriggerTranscode.mockClear(); });
  afterAll(disconnectTestDb);

  const buyerId = new mongoose.Types.ObjectId().toString();

  it('createUpdate persists a processing update and returns a presigned URL', async () => {
    const { update, uploadUrl } = await createUpdate({
      authorType: 'buyer', authorId: buyerId, kind: 'video', caption: 'hi', ext: 'mp4', contentType: 'video/mp4',
    });
    expect(uploadUrl).toContain('https://r2.example/put');
    expect(update.media.status).toBe('processing');
    expect(update.media.rawKey).toBe('updates/raw/1-abc.mp4');
  });

  it('finalizeUpdate(video) sets processingStartedAt and triggers transcode', async () => {
    const { update } = await createUpdate({ authorType: 'buyer', authorId: buyerId, kind: 'video', caption: '', ext: 'mp4', contentType: 'video/mp4' });
    const out = await finalizeUpdate(update.id);
    expect(out.media.status).toBe('processing');
    expect(out.media.processingStartedAt).toBeInstanceOf(Date);
    expect(mockTriggerTranscode).toHaveBeenCalledTimes(1);
  });

  it('finalizeUpdate(image) marks ready immediately with an image url', async () => {
    const { update } = await createUpdate({ authorType: 'buyer', authorId: buyerId, kind: 'image', caption: '', ext: 'jpg', contentType: 'image/jpeg' });
    const out = await finalizeUpdate(update.id);
    expect(out.media.status).toBe('ready');
    expect(out.media.image?.url).toContain('https://cdn.carrottickets.com/updates/raw/1-abc.jpg');
    expect(mockTriggerTranscode).not.toHaveBeenCalled();
  });
});
