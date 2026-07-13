import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

let vseq = 0;
const makeVendor = (name?: string) => {
  vseq += 1;
  return Vendor.create({
    businessName: name ?? `Brand ${vseq}`,
    email: `vendor${vseq}@example.com`,
    phoneNumber: `+2687${8000000 + vseq}`,
    password: 'secret123',
  });
};

describe('/api/tickets/social (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('GET /me returns the brand social summary', async () => {
    const vendor = await makeVendor('Bhora Fest');
    const res = await request(app).get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`).expect(200);
    expect(res.body.data).toMatchObject({ id: String(vendor._id), businessName: 'Bhora Fest', followerCount: 0, followingCount: 0 });
  });

  it('follows a buyer, reflects in followingCount, then unfollows', async () => {
    const vendor = await makeVendor();
    const buyer = await Buyer.create({ phone: '+26878000201', name: 'B', password: 'secret1' });
    const token = `Bearer ${signVendorToken(String(vendor._id))}`;

    await request(app).post('/api/tickets/social/follow')
      .set('Authorization', token).send({ targetType: 'buyer', targetId: String(buyer._id) }).expect(200);

    const me = await request(app).get('/api/tickets/social/me').set('Authorization', token).expect(200);
    expect(me.body.data.followingCount).toBe(1);

    await request(app).delete(`/api/tickets/social/follow/buyer/${buyer._id}`).set('Authorization', token).expect(200);
    const me2 = await request(app).get('/api/tickets/social/me').set('Authorization', token).expect(200);
    expect(me2.body.data.followingCount).toBe(0);
  });

  it('400s an invalid follow body', async () => {
    const vendor = await makeVendor();
    await request(app).post('/api/tickets/social/follow')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
      .send({ targetType: 'nope', targetId: 'x' }).expect(400);
  });

  it('401s a buyer token (no vendorId)', async () => {
    await request(app).get('/api/tickets/social/me')
      .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
  });
});
