import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken, signBuyerToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-a.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2/put'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined), reconcileStuckUpdates: jest.fn() }));

describe('POST /api/tickets/updates (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a vendor-authored update', async () => {
    // signSuperAdminToken()'s vendorId ('admin-vendor-id') is a placeholder
    // string, not a valid Mongo ObjectId, so it can't be persisted into
    // Update.authorId (which is typed ObjectId). Use signVendorToken() with
    // a real ObjectId for any assertion that touches the DB.
    const vendorId = new mongoose.Types.ObjectId().toString();
    const res = await request(app)
      .post('/api/tickets/updates')
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .send({ kind: 'image', caption: 'promo', ext: 'jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(res.body.data.updateId).toBeTruthy();
    expect(res.body.data.uploadUrl).toContain('https://r2/put');

    const saved = await Update.findById(res.body.data.updateId);
    expect(saved?.authorType).toBe('vendor');
    expect(String(saved?.authorId)).toBe(vendorId);
  });

  it('rejects a mismatched kind/contentType', async () => {
    await request(app)
      .post('/api/tickets/updates')
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ kind: 'video', caption: '', ext: 'jpg', contentType: 'image/jpeg' })
      .expect(400);
  });

  // authenticateTickets only requires a valid `app: 'tickets'` JWT — it does
  // NOT check userType (unlike authenticateBuyer, which explicitly rejects
  // non-buyer tokens). A buyer token therefore passes the middleware, but
  // carries no vendorId, so createAsVendor's own vendorId check 401s it.
  // Documented deviation from the brief's framing ("authenticateTickets
  // rejects buyer tokens") — the 401 still happens, just one layer up.
  it('401s a buyer token (no vendorId on the decoded token)', async () => {
    await request(app)
      .post('/api/tickets/updates')
      .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`)
      .send({ kind: 'image', caption: 'promo', ext: 'jpg', contentType: 'image/jpeg' })
      .expect(401);
  });

  it('401s without a token', async () => {
    await request(app)
      .post('/api/tickets/updates')
      .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
      .expect(401);
  });
});

describe('POST /api/tickets/updates/:id/finalize (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const seedVendorUpdate = async (authorId: string) =>
    Update.create({
      authorType: 'vendor',
      authorId,
      kind: 'image',
      caption: 'x',
      media: { rawKey: 'updates/raw/1-a.jpg', status: 'processing' },
    });

  it('finalizes the vendor own update', async () => {
    const vendorId = new mongoose.Types.ObjectId().toString();
    const update = await seedVendorUpdate(vendorId);
    const res = await request(app)
      .post(`/api/tickets/updates/${update.id}/finalize`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .expect(200);
    expect(res.body.data.media.status).toBe('ready');
  });

  it('forbids finalizing another vendor\'s update', async () => {
    const authorVendorId = new mongoose.Types.ObjectId().toString();
    const requestingVendorId = new mongoose.Types.ObjectId().toString();
    const update = await seedVendorUpdate(authorVendorId);
    await request(app)
      .post(`/api/tickets/updates/${update.id}/finalize`)
      .set('Authorization', `Bearer ${signVendorToken(requestingVendorId)}`)
      .expect(403);
  });
});
