import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signAdminSessionToken, signBuyerSessionToken, signVendorSessionToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
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
    const vendorId = String((await Vendor.create({ businessName: 'Author', password: 'secret123', logoUrl: 'https://cdn.carrottickets.com/test/logo.jpg' }))._id);
    const res = await request(app)
      .post('/api/tickets/updates')
      .set('Authorization', `Bearer ${await signVendorSessionToken(vendorId)}`)
      .send({ kind: 'image', caption: 'promo', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(201);
    expect(res.body.data.updateId).toBeTruthy();
    expect(res.body.data.uploads).toHaveLength(1);
    expect(res.body.data.uploads[0].uploadUrl).toContain('https://r2/put');

    const saved = await Update.findById(res.body.data.updateId);
    expect(saved?.authorType).toBe('vendor');
    expect(String(saved?.authorId)).toBe(vendorId);
  });

  it('rejects a mismatched kind/contentType', async () => {
    await request(app)
      .post('/api/tickets/updates')
      .set('Authorization', `Bearer ${await signAdminSessionToken()}`)
      .send({ kind: 'video', caption: '', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(400);
  });

  it('401s a buyer token (no vendorId on the decoded token)', async () => {
    await Buyer.create({ phone: '+26878422613', password: 'secret123', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    await request(app)
      .post('/api/tickets/updates')
      .set('Authorization', `Bearer ${await signBuyerSessionToken('+26878422613')}`)
      .send({ kind: 'image', caption: 'promo', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(401);
  });

  it('401s without a token', async () => {
    await request(app)
      .post('/api/tickets/updates')
      .send({ kind: 'image', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
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
      media: [{ rawKey: 'updates/raw/1-a.jpg', status: 'processing' }],
    });

  it('finalizes the vendor own update', async () => {
    const vendorId = String((await Vendor.create({ businessName: 'Author', password: 'secret123', logoUrl: 'https://cdn.carrottickets.com/test/logo.jpg' }))._id);
    const update = await seedVendorUpdate(vendorId);
    const res = await request(app)
      .post(`/api/tickets/updates/${update.id}/finalize`)
      .set('Authorization', `Bearer ${await signVendorSessionToken(vendorId)}`)
      .expect(200);
    expect(res.body.data.media[0].status).toBe('ready');
  });

  it('forbids finalizing another vendor\'s update', async () => {
    const authorVendorId = new mongoose.Types.ObjectId().toString();
    const requestingVendorId = String((await Vendor.create({ businessName: 'Other', password: 'secret123' }))._id);
    const update = await seedVendorUpdate(authorVendorId);
    await request(app)
      .post(`/api/tickets/updates/${update.id}/finalize`)
      .set('Authorization', `Bearer ${await signVendorSessionToken(requestingVendorId)}`)
      .expect(403);
  });
});
