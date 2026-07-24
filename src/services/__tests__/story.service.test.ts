import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { createStory, finalizeStory, listForViewer, markSeen } from '@services/story.service';
import { Story } from '@models/story.model';
import { StorySeen } from '@models/storySeen.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { FollowService } from '@services/follow.service';
import { HttpError } from '@utils/httpError.util';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
const mockTriggerTranscode = jest.fn().mockResolvedValue(undefined);
jest.mock('@services/transcode.client', () => ({ triggerTranscode: (...a: any[]) => mockTriggerTranscode(...a) }));

describe('story.service', () => {
  beforeAll(connectTestDb);
  afterEach(async () => { await clearTestDb(); mockTriggerTranscode.mockClear(); });
  afterAll(disconnectTestDb);

  const buyerId = () => new mongoose.Types.ObjectId().toString();

  describe('createStory / finalizeStory', () => {
    it('createStory persists a processing story with a 24h expiry and returns a presigned URL', async () => {
      const before = Date.now();
      const { story, uploadUrl } = await createStory({
        actor: { type: 'buyer', id: buyerId() }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg',
      });
      expect(uploadUrl).toContain('https://r2.example/put');
      expect(story.media.status).toBe('processing');
      expect(story.media.rawKey).toBe('updates/raw/1-abc.jpg');
      const expiresInMs = story.expiresAt.getTime() - before;
      expect(expiresInMs).toBeGreaterThan(23.9 * 3600 * 1000);
      expect(expiresInMs).toBeLessThan(24.1 * 3600 * 1000);
    });

    it('finalizeStory(image) marks ready immediately with an image url', async () => {
      const { story } = await createStory({ actor: { type: 'buyer', id: buyerId() }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      const out = await finalizeStory(story.id);
      expect(out.media.status).toBe('ready');
      expect(out.media.image?.url).toBe('https://cdn.carrottickets.com/updates/raw/1-abc.jpg');
      expect(mockTriggerTranscode).not.toHaveBeenCalled();
    });

    it('finalizeStory(video) sets processingStartedAt and triggers transcode', async () => {
      const { story } = await createStory({ actor: { type: 'buyer', id: buyerId() }, kind: 'video', ext: 'mp4', contentType: 'video/mp4' });
      const out = await finalizeStory(story.id);
      expect(out.media.status).toBe('processing');
      expect(out.media.processingStartedAt).toBeInstanceOf(Date);
      expect(mockTriggerTranscode).toHaveBeenCalledTimes(1);
      expect(mockTriggerTranscode).toHaveBeenCalledWith(expect.objectContaining({ id: story.id }));
    });

    it('finalizeStory throws 404 for an unknown id', async () => {
      await expect(finalizeStory(new mongoose.Types.ObjectId().toString())).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('markSeen', () => {
    it('is idempotent — calling twice creates only one StorySeen row', async () => {
      const { story } = await createStory({ actor: { type: 'buyer', id: buyerId() }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      const viewer = { type: 'buyer' as const, id: buyerId() };
      await markSeen(story.id, viewer);
      await markSeen(story.id, viewer);
      const rows = await StorySeen.find({ storyId: story.id, buyerId: viewer.id });
      expect(rows).toHaveLength(1);
    });

    it('throws 404 for an unknown story id', async () => {
      await expect(markSeen(new mongoose.Types.ObjectId().toString(), { type: 'buyer', id: buyerId() })).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe('listForViewer', () => {
    const seedBuyer = (phone: string, extra: Record<string, unknown> = {}) => Buyer.create({ phone, password: 'secret1', ...extra });
    const seedReadyStory = (authorType: 'buyer' | 'vendor', authorId: string, overrides: Record<string, unknown> = {}) =>
      Story.create({
        authorType, authorId, kind: 'image',
        media: { rawKey: 'k', status: 'ready', image: { url: `https://cdn.carrottickets.com/${authorId}.jpg`, width: 1, height: 1 } },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        ...overrides,
      });

    it('includes the viewer\'s own story, marked isOwn, even when nobody follows them', async () => {
      const viewer = await seedBuyer('+26878400001');
      await seedReadyStory('buyer', String(viewer._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.isOwn).toBe(true);
      expect(groups[0]!.author.id).toBe(String(viewer._id));
    });

    it('includes a followed buyer\'s ready story, grouped, seen:false', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400002');
      const author = await seedBuyer('+26878400003', { name: 'Author Buyer' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await seedReadyStory('buyer', String(author._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      const g = groups[0]!;
      expect(g.isOwn).toBe(false);
      expect(g.seen).toBe(false);
      expect(g.author).toEqual({ type: 'buyer', id: String(author._id), name: 'Author Buyer', avatarUrl: null });
      expect(g.items).toHaveLength(1);
      expect(g.items[0]!.mediaUrl).toContain('.jpg');
    });

    it('includes a followed organizer (vendor) story, author.type=organizer', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400004');
      const vendor = await Vendor.create({ businessName: 'Acme Events', email: 'acme@x.co', password: 'secret1' });
      await FollowService.follow(viewer, 'organizer', String(vendor._id));
      await seedReadyStory('vendor', String(vendor._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.author).toEqual({ type: 'organizer', id: String(vendor._id), name: 'Acme Events', avatarUrl: null });
    });

    it('excludes a story from a NON-followed author (and not own)', async () => {
      const viewer = await seedBuyer('+26878400005');
      const stranger = await seedBuyer('+26878400006');
      await seedReadyStory('buyer', String(stranger._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(0);
    });

    it('excludes an EXPIRED story (expiresAt in the past)', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400007');
      const author = await seedBuyer('+26878400008');
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await seedReadyStory('buyer', String(author._id), { expiresAt: new Date(Date.now() - 1000) });

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(0);
    });

    it('excludes a still-processing (not-ready) story', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400009');
      const author = await seedBuyer('+26878400010');
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await Story.create({
        authorType: 'buyer', authorId: author._id, kind: 'video',
        media: { rawKey: 'k', status: 'processing' },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(0);
    });

    it('reflects seen:true after markSeen for every item in the group', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400011');
      const author = await seedBuyer('+26878400012');
      await FollowService.follow(viewer, 'buyer', String(author._id));
      const story = await seedReadyStory('buyer', String(author._id));

      await markSeen(story.id, { type: 'buyer', id: String(viewer._id) });
      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups[0]!.seen).toBe(true);
    });

    it('orders own first, then unseen, then fully-seen', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400013');
      const seenAuthor = await seedBuyer('+26878400014');
      const unseenAuthor = await seedBuyer('+26878400015');
      await FollowService.follow(viewer, 'buyer', String(seenAuthor._id));
      await FollowService.follow(viewer, 'buyer', String(unseenAuthor._id));
      const seenStory = await seedReadyStory('buyer', String(seenAuthor._id));
      await seedReadyStory('buyer', String(unseenAuthor._id));
      await seedReadyStory('buyer', String(viewer._id)); // own
      await markSeen(seenStory.id, { type: 'buyer', id: String(viewer._id) });

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(3);
      expect(groups[0]!.isOwn).toBe(true);
      expect(groups[1]!.author.id).toBe(String(unseenAuthor._id));
      expect(groups[1]!.seen).toBe(false);
      expect(groups[2]!.author.id).toBe(String(seenAuthor._id));
      expect(groups[2]!.seen).toBe(true);
    });

    it('returns an empty array with no fake data when nothing is active', async () => {
      const viewer = await seedBuyer('+26878400016');
      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toEqual([]);
    });
  });
});
