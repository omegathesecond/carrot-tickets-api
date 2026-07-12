import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import mongoose from 'mongoose';

jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn(), reconcileStuckUpdates: jest.fn() }));

describe('GET /api/public/feed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns items array and nextCursor (no auth required)', async () => {
    await Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: 'hi', media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } } });
    const res = await request(app).get('/api/public/feed?tab=for-you').expect(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data).toHaveProperty('nextCursor');
  });

  it('rejects an unknown tab', async () => {
    await request(app).get('/api/public/feed?tab=bogus').expect(400);
  });
});
