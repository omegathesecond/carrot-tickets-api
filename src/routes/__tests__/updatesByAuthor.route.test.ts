import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';

jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn(), reconcileStuckUpdates: jest.fn() }));

const readyImageMedia = { rawKey: 'k', status: 'ready' as const, image: { url: 'https://x/i.jpg', width: 1, height: 1 } };

describe('GET /api/public/updates/by/:authorType/:authorId', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it("returns that vendor's ready updates, newest first", async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const older = await Update.create({
      authorType: 'vendor', authorId: vendorId, kind: 'image', caption: 'older',
      media: readyImageMedia, createdAt: new Date('2026-07-01'),
    });
    const newer = await Update.create({
      authorType: 'vendor', authorId: vendorId, kind: 'image', caption: 'newer',
      media: readyImageMedia, createdAt: new Date('2026-07-10'),
    });
    // noise: different author, unready media, and a removed post by the same author
    await Update.create({ authorType: 'vendor', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: 'not-me', media: readyImageMedia });
    await Update.create({ authorType: 'vendor', authorId: vendorId, kind: 'video', caption: 'still-processing', media: { rawKey: 'k2', status: 'processing' } });
    const removed = await Update.create({ authorType: 'vendor', authorId: vendorId, kind: 'image', caption: 'removed', media: readyImageMedia });
    removed.status = 'removed';
    await removed.save();

    const res = await request(app).get(`/api/public/updates/by/vendor/${vendorId.toHexString()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    // newest first
    expect(res.body.data.items[0].id).toBe(newer.id);
    expect(res.body.data.items[1].id).toBe(older.id);
    // reuses the real UpdateDTO shape (UpdateController.dto)
    expect(res.body.data.items[0]).toMatchObject({
      authorType: 'vendor',
      authorId: vendorId.toHexString(),
      kind: 'image',
      caption: 'newer',
      likeCount: 0,
      saveCount: 0,
      shareCount: 0,
      viewCount: 0,
      viewerReactions: null,
    });
    expect(res.body.data.items[0].media.status).toBe('ready');
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('400s on a bad authorType', async () => {
    const res = await request(app).get('/api/public/updates/by/robot/507f1f77bcf86cd799439011');
    expect(res.status).toBe(400);
  });

  it('400s on a malformed authorId', async () => {
    const res = await request(app).get('/api/public/updates/by/vendor/not-a-hex-id');
    expect(res.status).toBe(400);
  });

  it('paginates with a cursor at page size 24', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const base = new Date('2026-06-01').getTime();
    for (let i = 0; i < 25; i++) {
      await Update.create({
        authorType: 'vendor', authorId: vendorId, kind: 'image', caption: `p${i}`,
        media: readyImageMedia, createdAt: new Date(base + i * 1000),
      });
    }

    const page1 = await request(app).get(`/api/public/updates/by/vendor/${vendorId.toHexString()}`);
    expect(page1.status).toBe(200);
    expect(page1.body.data.items).toHaveLength(24);
    expect(page1.body.data.nextCursor).toBeTruthy();
    // newest (i=24) first
    expect(page1.body.data.items[0].caption).toBe('p24');

    const page2 = await request(app)
      .get(`/api/public/updates/by/vendor/${vendorId.toHexString()}`)
      .query({ cursor: page1.body.data.nextCursor });
    expect(page2.status).toBe(200);
    expect(page2.body.data.items).toHaveLength(1);
    expect(page2.body.data.items[0].caption).toBe('p0');
    expect(page2.body.data.nextCursor).toBeNull();
  });

  it("includes the caller's viewerReactions when a vendor token is present", async () => {
    const authorId = new mongoose.Types.ObjectId();
    const viewerId = new mongoose.Types.ObjectId().toHexString();
    const update = await Update.create({ authorType: 'vendor', authorId, kind: 'image', caption: 'x', media: readyImageMedia });
    await request(app)
      .post(`/api/tickets/updates/${update.id}/like`)
      .set('Authorization', `Bearer ${signVendorToken(viewerId)}`)
      .expect(200);

    const res = await request(app)
      .get(`/api/public/updates/by/vendor/${authorId.toHexString()}`)
      .set('Authorization', `Bearer ${signVendorToken(viewerId)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].viewerReactions).toEqual({ liked: true, saved: false });
  });

  it('400s on a malformed cursor rather than silently returning an empty page', async () => {
    const res = await request(app).get('/api/public/updates/by/vendor/507f1f77bcf86cd799439011?cursor=not-a-date');
    expect(res.status).toBe(400);
  });

  // viewerIsAuthor is what lets the client offer delete only on your own post.
  // Server-computed (like viewerReactions) so the client needn't bridge the
  // model's authorType:'vendor' vs the feed's author.type:'organizer' naming.
  it('sets viewerIsAuthor true for the vendor who authored the posts', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    await Update.create({
      authorType: 'vendor', authorId: vendorId, kind: 'image', caption: 'mine',
      media: readyImageMedia,
    });

    const res = await request(app)
      .get(`/api/public/updates/by/vendor/${vendorId.toHexString()}`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId.toHexString())}`)
      .expect(200);

    expect(res.body.data.items[0].viewerIsAuthor).toBe(true);
  });

  it('sets viewerIsAuthor false for a different vendor', async () => {
    const author = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await Update.create({
      authorType: 'vendor', authorId: author, kind: 'image', caption: 'theirs',
      media: readyImageMedia,
    });

    const res = await request(app)
      .get(`/api/public/updates/by/vendor/${author.toHexString()}`)
      .set('Authorization', `Bearer ${signVendorToken(other.toHexString())}`)
      .expect(200);

    expect(res.body.data.items[0].viewerIsAuthor).toBe(false);
  });

  it('sets viewerIsAuthor false for an anonymous viewer', async () => {
    const author = new mongoose.Types.ObjectId();
    await Update.create({
      authorType: 'vendor', authorId: author, kind: 'image', caption: 'theirs',
      media: readyImageMedia,
    });

    const res = await request(app)
      .get(`/api/public/updates/by/vendor/${author.toHexString()}`)
      .expect(200);

    expect(res.body.data.items[0].viewerIsAuthor).toBe(false);
  });
});
