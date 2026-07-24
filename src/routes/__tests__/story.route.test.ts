import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Story } from '@models/story.model';
import { FollowService } from '@services/follow.service';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined), reconcileStuckUpdates: jest.fn() }));

const PHONE = '+26878422613';
const AUTHOR_PHONE = '+26878400101';

describe('Stories API', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('POST /api/social/stories', () => {
    it('creates a processing story and returns a presigned upload url', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Poster' });
      const res = await request(app)
        .post('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(201);

      expect(res.body.data.uploadUrl).toContain('https://r2.example/put');
      expect(res.body.data.storyId).toBeTruthy();
      const stored = await Story.findById(res.body.data.storyId);
      expect(stored?.media.status).toBe('processing');
      expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('401s without a token', async () => {
      await request(app).post('/api/social/stories').send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' }).expect(401);
    });
  });

  describe('POST /api/social/stories/:id/finalize', () => {
    it('marks an image story ready with a url', async () => {
      const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Poster' });
      const create = await request(app)
        .post('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(201);

      const res = await request(app)
        .post(`/api/social/stories/${create.body.data.storyId}/finalize`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);

      expect(res.body.data.media.status).toBe('ready');
      expect(res.body.data.media.image.url).toBe('https://cdn.carrottickets.com/updates/raw/1-abc.jpg');
      void buyer;
    });

    it("forbids finalizing someone else's story", async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Poster' });
      const other = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', name: 'Other' });
      const story = await Story.create({
        authorType: 'buyer', authorId: other._id, kind: 'image',
        media: { rawKey: 'k', status: 'processing' },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      await request(app)
        .post(`/api/social/stories/${story.id}/finalize`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(403);
    });

    it('401s without a token', async () => {
      await request(app).post('/api/social/stories/000000000000000000000000/finalize').expect(401);
    });
  });

  describe('GET /api/social/stories', () => {
    const seedReadyStory = (authorId: string, overrides: Record<string, unknown> = {}) =>
      Story.create({
        authorType: 'buyer', authorId, kind: 'image',
        media: { rawKey: 'k', status: 'ready', image: { url: `https://cdn.carrottickets.com/${authorId}.jpg`, width: 1, height: 1 } },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        ...overrides,
      });

    it("returns a followed author's ready active story grouped, seen:false, then seen:true after marking it seen", async () => {
      const viewer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Viewer' });
      const author = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', name: 'Author' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      const story = await seedReadyStory(String(author._id));

      const auth = `Bearer ${signBuyerToken(PHONE)}`;
      const first = await request(app).get('/api/social/stories').set('Authorization', auth).expect(200);
      expect(first.body.data.stories).toHaveLength(1);
      expect(first.body.data.stories[0].seen).toBe(false);
      expect(first.body.data.stories[0].author.id).toBe(String(author._id));

      await request(app).post(`/api/social/stories/${story.id}/seen`).set('Authorization', auth).expect(200);

      const second = await request(app).get('/api/social/stories').set('Authorization', auth).expect(200);
      expect(second.body.data.stories[0].seen).toBe(true);
    });

    it('excludes an EXPIRED story (expiresAt in the past)', async () => {
      const viewer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Viewer' });
      const author = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', name: 'Author' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await seedReadyStory(String(author._id), { expiresAt: new Date(Date.now() - 1000) });

      const res = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(res.body.data.stories).toEqual([]);
    });

    it('excludes a story from a non-followed author', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Viewer' });
      const stranger = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', name: 'Stranger' });
      await seedReadyStory(String(stranger._id));

      const res = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(res.body.data.stories).toEqual([]);
    });

    it('401s without a token', async () => {
      await request(app).get('/api/social/stories').expect(401);
    });
  });

  describe('POST /api/social/stories/:id/seen', () => {
    it('401s without a token', async () => {
      await request(app).post('/api/social/stories/000000000000000000000000/seen').expect(401);
    });
  });
});
