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

  // The feed renames a vendor author to author.type:'organizer', while a
  // SocialActor says 'vendor'. A naive compare would mean a brand NEVER owns
  // its own post and the ⋯ delete would never appear in the feed.
  it('marks viewerIsAuthor=true on the viewing vendor\'s own post', async () => {
    const vendorId = new mongoose.Types.ObjectId().toHexString();
    const u = await Update.create({
      authorType: 'vendor', authorId: vendorId, kind: 'image', caption: 'mine',
      media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } },
    });

    const res = await request(app)
      .get('/api/public/feed?tab=for-you')
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(200);

    const slide = res.body.data.items.find((i: any) => i.type === 'update' && i.id === u.id);
    expect(slide).toBeTruthy();
    expect(slide.author.type).toBe('organizer'); // the naming seam, pinned
    expect(slide.viewerIsAuthor).toBe(true);
  });

  it("marks viewerIsAuthor=false on another brand's post", async () => {
    const author = new mongoose.Types.ObjectId().toHexString();
    const viewer = new mongoose.Types.ObjectId().toHexString();
    const u = await Update.create({
      authorType: 'vendor', authorId: author, kind: 'image', caption: 'theirs',
      media: { rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } },
    });

    const res = await request(app)
      .get('/api/public/feed?tab=for-you')
      .set('Authorization', `Bearer ${signVendorToken(viewer)}`)
      .expect(200);

    const slide = res.body.data.items.find((i: any) => i.type === 'update' && i.id === u.id);
    expect(slide).toBeTruthy();
    expect(slide.viewerIsAuthor).toBe(false);
  });
});
