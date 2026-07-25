import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';

jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn(), reconcileStuckUpdates: jest.fn() }));

const readyImageMedia = { rawKey: 'k', status: 'ready' as const, image: { url: 'https://x/i.jpg', width: 1, height: 1 } };
const processingMedia = { rawKey: 'k2', status: 'processing' as const };

function makeUpdate(hashtags: string[], overrides: Record<string, any> = {}) {
  return {
    authorType: 'buyer',
    authorId: new mongoose.Types.ObjectId(),
    kind: 'image',
    caption: 'x',
    hashtags,
    media: readyImageMedia,
    ...overrides,
  };
}

describe('GET /api/public/topics/:tag/posts', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns posts containing the tag, newest first', async () => {
    const older = await Update.create(makeUpdate(['music'], { caption: 'older', createdAt: new Date('2026-07-01') }));
    const newer = await Update.create(makeUpdate(['music'], { caption: 'newer', createdAt: new Date('2026-07-10') }));

    const res = await request(app).get('/api/public/topics/music/posts');
    expect(res.status).toBe(200);
    expect(res.body.data.tag).toBe('music');
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.posts).toHaveLength(2);
    expect(res.body.data.posts[0].id).toBe(newer.id);
    expect(res.body.data.posts[1].id).toBe(older.id);
    // reuses the real UpdateDTO shape (UpdateController.dto)
    expect(res.body.data.posts[0]).toMatchObject({
      authorType: 'buyer',
      kind: 'image',
      caption: 'newer',
      likeCount: 0,
      saveCount: 0,
      shareCount: 0,
      viewCount: 0,
      viewerReactions: null,
    });
  });

  it('normalizes the tag param (case + leading #) the same way hashtags are stored', async () => {
    await Update.create(makeUpdate(['music']));

    const res = await request(app).get('/api/public/topics/%23MUSIC/posts');
    expect(res.status).toBe(200);
    expect(res.body.data.tag).toBe('music');
    expect(res.body.data.posts).toHaveLength(1);
  });

  it('excludes a post that does not contain the tag', async () => {
    await Update.create(makeUpdate(['music']));
    await Update.create(makeUpdate(['food']));

    const res = await request(app).get('/api/public/topics/music/posts');
    expect(res.status).toBe(200);
    expect(res.body.data.posts).toHaveLength(1);
    expect(res.body.data.posts[0].caption).toBe('x');
  });

  it('excludes a removed post', async () => {
    const removed = await Update.create(makeUpdate(['music']));
    removed.status = 'removed';
    await removed.save();
    await Update.create(makeUpdate(['music']));

    const res = await request(app).get('/api/public/topics/music/posts');
    expect(res.status).toBe(200);
    expect(res.body.data.posts).toHaveLength(1);
  });

  it('excludes a post whose media is not ready', async () => {
    await Update.create(makeUpdate(['music'], { media: processingMedia }));
    await Update.create(makeUpdate(['music']));

    const res = await request(app).get('/api/public/topics/music/posts');
    expect(res.status).toBe(200);
    expect(res.body.data.posts).toHaveLength(1);
  });

  it('paginates with page/limit and sets hasMore correctly', async () => {
    const base = new Date('2026-06-01').getTime();
    for (let i = 0; i < 5; i++) {
      await Update.create(makeUpdate(['music'], { caption: `p${i}`, createdAt: new Date(base + i * 1000) }));
    }

    const page1 = await request(app).get('/api/public/topics/music/posts').query({ limit: 2, page: 1 });
    expect(page1.status).toBe(200);
    expect(page1.body.data.posts).toHaveLength(2);
    expect(page1.body.data.posts[0].caption).toBe('p4');
    expect(page1.body.data.posts[1].caption).toBe('p3');
    expect(page1.body.data.hasMore).toBe(true);
    expect(page1.body.data.page).toBe(1);

    const page2 = await request(app).get('/api/public/topics/music/posts').query({ limit: 2, page: 2 });
    expect(page2.status).toBe(200);
    expect(page2.body.data.posts).toHaveLength(2);
    expect(page2.body.data.posts[0].caption).toBe('p2');
    expect(page2.body.data.posts[1].caption).toBe('p1');
    expect(page2.body.data.hasMore).toBe(true);

    const page3 = await request(app).get('/api/public/topics/music/posts').query({ limit: 2, page: 3 });
    expect(page3.status).toBe(200);
    expect(page3.body.data.posts).toHaveLength(1);
    expect(page3.body.data.posts[0].caption).toBe('p0');
    expect(page3.body.data.hasMore).toBe(false);
  });

  it('clamps an out-of-range limit', async () => {
    const res = await request(app).get('/api/public/topics/music/posts').query({ limit: 999 });
    expect(res.status).toBe(400);
  });

  it('returns { posts: [], hasMore: false } for a tag with no visible posts', async () => {
    const res = await request(app).get('/api/public/topics/nosuchtag/posts');
    expect(res.status).toBe(200);
    expect(res.body.data.posts).toEqual([]);
    expect(res.body.data.hasMore).toBe(false);
  });

  it("includes the caller's viewerReactions when a token is present", async () => {
    const viewerId = new mongoose.Types.ObjectId().toHexString();
    const update = await Update.create(makeUpdate(['music']));
    await request(app)
      .post(`/api/tickets/updates/${update.id}/like`)
      .set('Authorization', `Bearer ${signVendorToken(viewerId)}`)
      .expect(200);

    const res = await request(app)
      .get('/api/public/topics/music/posts')
      .set('Authorization', `Bearer ${signVendorToken(viewerId)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.posts[0].viewerReactions).toEqual({ liked: true, saved: false });
  });
});
