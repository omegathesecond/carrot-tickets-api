import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import { Buyer } from '@models/buyer.model';
import mongoose from 'mongoose';

jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn(), reconcileStuckUpdates: jest.fn() }));

describe('GET /api/public/feed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns items array and nextCursor (no auth required)', async () => {
    await Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: 'hi', media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }] });
    const res = await request(app).get('/api/public/feed?tab=for-you').expect(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('includes real activity posts only when the Home surface is requested', async () => {
    const sourceId = new mongoose.Types.ObjectId();
    const actor = await Buyer.create({ phone: '+26878000001', password: 'test-only-password', username: 'actor', name: 'Actor' });
    const post = await Update.create({ authorType: 'buyer', authorId: actor._id, kind: 'image', caption: 'A now follows B.',
      activitySource: { type: 'follow', id: sourceId, targetType: 'buyer', targetId: new mongoose.Types.ObjectId(), subjectId: new mongoose.Types.ObjectId() },
      media: [{ rawKey: 'b.jpg', status: 'ready', image: { url: 'https://cdn.example/b.jpg', width: 10, height: 10 } }] });
    const home = await request(app).get('/api/public/feed?tab=for-you&surface=home').expect(200);
    expect(home.body.data.items.some((i: { id: string }) => i.id === post.id)).toBe(true);
    const discover = await request(app).get('/api/public/feed?tab=for-you').expect(200);
    expect(discover.body.data.items.some((i: { id: string }) => i.id === post.id)).toBe(false);
    await request(app).get('/api/public/feed?tab=for-you&surface=bogus').expect(400);
  });

  it('rejects an unknown tab', async () => {
    await request(app).get('/api/public/feed?tab=bogus').expect(400);
  });
});
