import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
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

describe('GET /api/public/trending', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('ranks hashtags by post count over the last 14 days, marking the top 3 hot', async () => {
    // #music: 3 recent posts -> rank 1
    await Update.create(makeUpdate(['music']));
    await Update.create(makeUpdate(['music', 'live']));
    await Update.create(makeUpdate(['music']));
    // #food: 2 recent posts -> rank 2
    await Update.create(makeUpdate(['food']));
    await Update.create(makeUpdate(['food']));
    // #art: 1 recent post -> lower rank
    await Update.create(makeUpdate(['art']));

    const res = await request(app).get('/api/public/trending');
    expect(res.status).toBe(200);
    const trending = res.body.data.trending;

    expect(trending[0]).toMatchObject({ tag: 'music', posts: 3, hot: true });
    expect(trending[1]).toMatchObject({ tag: 'food', posts: 2, hot: true });
    // whatever lands in 3rd place overall must be hot
    expect(trending[2].hot).toBe(true);
    // anything past the top 3 must not be hot
    for (const item of trending.slice(3)) {
      expect(item.hot).toBe(false);
    }
  });

  it('excludes an update older than 14 days', async () => {
    await Update.create(makeUpdate(['recenttag']));
    await Update.create(
      makeUpdate(['staletag'], { createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) }),
    );

    const res = await request(app).get('/api/public/trending');
    expect(res.status).toBe(200);
    const tags = res.body.data.trending.map((t: any) => t.tag);
    expect(tags).toContain('recenttag');
    expect(tags).not.toContain('staletag');
  });

  it('excludes removed and not-yet-ready updates', async () => {
    const removed = await Update.create(makeUpdate(['removedtag']));
    removed.status = 'removed';
    await removed.save();
    await Update.create(makeUpdate(['processingtag'], { media: processingMedia }));
    await Update.create(makeUpdate(['visibletag']));

    const res = await request(app).get('/api/public/trending');
    expect(res.status).toBe(200);
    const tags = res.body.data.trending.map((t: any) => t.tag);
    expect(tags).toContain('visibletag');
    expect(tags).not.toContain('removedtag');
    expect(tags).not.toContain('processingtag');
  });

  it('returns { trending: [] } when there is no recent hashtagged activity', async () => {
    const res = await request(app).get('/api/public/trending');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ trending: [] });
  });
});
