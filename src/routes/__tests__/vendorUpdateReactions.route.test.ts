import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Update } from '@models/update.model';

const seedReadyUpdate = () => Update.create({
  authorType: 'vendor', authorId: new mongoose.Types.ObjectId(),
  kind: 'image', caption: 'x', media: { rawKey: 'k', status: 'ready' }, status: 'active',
});

describe('POST /api/tickets/updates/:id/like|save (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets a vendor like and un-like an update', async () => {
    const u = await seedReadyUpdate();
    const token = signVendorToken(new mongoose.Types.ObjectId().toString());
    const on = await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(on.body.data).toMatchObject({ active: true, likeCount: 1 });
    const off = await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(off.body.data).toMatchObject({ active: false, likeCount: 0 });
  });

  it('lets a vendor save an update', async () => {
    const u = await seedReadyUpdate();
    const token = signVendorToken(new mongoose.Types.ObjectId().toString());
    const res = await request(app).post(`/api/tickets/updates/${u.id}/save`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.data).toMatchObject({ active: true, saveCount: 1 });
  });

  it('404s a removed update', async () => {
    const u = await seedReadyUpdate();
    u.status = 'removed'; await u.save();
    await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', `Bearer ${signVendorToken(new mongoose.Types.ObjectId().toString())}`).expect(404);
  });

  it('401s a buyer token (no vendorId → not a vendor actor on this route)', async () => {
    const u = await seedReadyUpdate();
    await request(app).post(`/api/tickets/updates/${u.id}/like`).set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
  });
});
