import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';

describe('vendor reactions end-to-end via feed + getOne', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('like via API is visible in getOne and the feed for that vendor', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const token = `Bearer ${signVendorToken(vendorId)}`;
    const u = await Update.create({
      authorType: 'vendor', authorId: new mongoose.Types.ObjectId(),
      kind: 'image', caption: 'x', media: { rawKey: 'k', status: 'ready' }, status: 'active',
    });

    await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', token).expect(200);

    const one = await request(app).get(`/api/public/updates/${u.id}`).set('Authorization', token).expect(200);
    expect(one.body.data.viewerReactions).toEqual({ liked: true, saved: false });

    const feed = await request(app).get('/api/public/feed?tab=for-you').set('Authorization', token).expect(200);
    const slide = feed.body.data.items.find((i: any) => i.type === 'update' && i.id === u.id);
    expect(slide.viewerReactions.liked).toBe(true);
  });
});
