import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';
import { toggleReaction } from '@services/update.service';

describe('GET /api/public/feed — vendor viewer reactions', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('marks viewerReactions.liked=true for an update the viewing vendor liked', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const u = await Update.create({
      authorType: 'vendor', authorId: new mongoose.Types.ObjectId(),
      kind: 'image', caption: 'x', media: { rawKey: 'k', status: 'ready' }, status: 'active',
    });
    await toggleReaction(u.id, { type: 'vendor', id: vendorId }, 'like');

    const res = await request(app)
      .get('/api/public/feed?tab=for-you')
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(200);

    const slide = res.body.data.items.find((i: any) => i.type === 'update' && i.id === u.id);
    expect(slide).toBeTruthy();
    expect(slide.viewerReactions).toEqual({ liked: true, saved: false });
  });
});
