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
    const { update, uploads } = await createUpdate({
      authorType: 'buyer', authorId: buyerId, kind: 'video', caption: 'hi', items: [{ ext: 'mp4', contentType: 'video/mp4' }],
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.uploadUrl).toContain('https://r2.example/put');
    expect(update.media).toHaveLength(1);
    expect(update.media[0]!.status).toBe('processing');
    expect(update.media[0]!.rawKey).toBe('updates/raw/1-abc.mp4');
  });

  it('createUpdate extracts hashtags from the caption', async () => {
    const { update } = await createUpdate({
      authorType: 'buyer', authorId: buyerId, kind: 'image', caption: 'Live now #Music #Live', items: [{ ext: 'jpg', contentType: 'image/jpeg' }],
    });
    expect(update.hashtags).toEqual(['music', 'live']);
  });

  it('createUpdate defaults hashtags to [] when caption has none', async () => {
    const { update } = await createUpdate({
      authorType: 'buyer', authorId: buyerId, kind: 'image', caption: 'no tags here', items: [{ ext: 'jpg', contentType: 'image/jpeg' }],
    });
    expect(update.hashtags).toEqual([]);
  });

  it('createUpdate mints one upload per item and N processing items', async () => {
    const { update, uploads } = await createUpdate({
      authorType: 'buyer', authorId: '507f1f77bcf86cd799439011', kind: 'image', caption: '',
      items: [{ ext: 'jpg', contentType: 'image/jpeg' }, { ext: 'png', contentType: 'image/png' }],
    } as any);
    expect(uploads).toHaveLength(2);
    expect(uploads.map((u: any) => u.index)).toEqual([0, 1]);
    expect(update.media).toHaveLength(2);
    expect(update.media.every((m: any) => m.status === 'processing')).toBe(true);
  });

  it('finalizeUpdate(video) sets processingStartedAt and triggers transcode', async () => {
    const { update } = await createUpdate({ authorType: 'buyer', authorId: buyerId, kind: 'video', caption: '', items: [{ ext: 'mp4', contentType: 'video/mp4' }] });
    const out = await finalizeUpdate(update.id);
    expect(out.media[0]!.status).toBe('processing');
    expect(out.media[0]!.processingStartedAt).toBeInstanceOf(Date);
    expect(mockTriggerTranscode).toHaveBeenCalledTimes(1);
    // Regression: must tell the transcoder to target the `updates` collection
    // (explicit now that Transcodable.collection also serves Story — see
    // transcode.client#Transcodable), not fall through to some default.
    expect(mockTriggerTranscode).toHaveBeenCalledWith(expect.objectContaining({ id: update.id, collection: 'updates' }));
  });

  it('finalizeUpdate(image) marks ready immediately with an image url', async () => {
    const { update } = await createUpdate({ authorType: 'buyer', authorId: buyerId, kind: 'image', caption: '', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] });
    const out = await finalizeUpdate(update.id);
    expect(out.media[0]!.status).toBe('ready');
    expect(out.media[0]!.image?.url).toContain('https://cdn.carrottickets.com/updates/raw/1-abc.jpg');
    expect(mockTriggerTranscode).not.toHaveBeenCalled();
  });

  it('finalize sets every photo item ready with a public url', async () => {
    const { update } = await createUpdate({
      authorType: 'buyer', authorId: buyerId,
      kind: 'image', caption: 'hi', items: [{ ext: 'jpg', contentType: 'image/jpeg' }],
    });
    const done = await finalizeUpdate(update.id);
    expect(done.media).toHaveLength(1);
    expect(done.media[0]!.status).toBe('ready');
    expect(done.media[0]!.image?.url).toContain(done.media[0]!.rawKey);
  });

  // Guards against a regression where the finalize loop only touches
  // media[0] and every subsequent item silently collapses to the FIRST
  // item's rawKey/url instead of its own. Two distinct extensions (jpg vs
  // png) mean the mocked rawKey differs per item, so we can assert each
  // media entry's url is derived from ITS OWN rawKey, not a shared one.
  it('finalize sets EACH photo item ready with a url derived from its own rawKey', async () => {
    const { update } = await createUpdate({
      authorType: 'buyer', authorId: buyerId, kind: 'image', caption: '',
      items: [{ ext: 'jpg', contentType: 'image/jpeg' }, { ext: 'png', contentType: 'image/png' }],
    });
    const done = await finalizeUpdate(update.id);
    expect(done.media).toHaveLength(2);
    expect(done.media[0]!.rawKey).not.toBe(done.media[1]!.rawKey);
    for (const item of done.media) {
      expect(item.status).toBe('ready');
      expect(item.image?.url).toContain(item.rawKey);
    }
  });
});
