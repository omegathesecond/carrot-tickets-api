import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';

describe('vendor follows an organizer end-to-end', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('brand A follows brand B; A.following=1 and B.followerCount=1', async () => {
    const a = await Vendor.create({ businessName: 'Brand A', email: 'brand-a@example.com', password: 'secret123', phoneNumber: '+26878000301' });
    const b = await Vendor.create({ businessName: 'Brand B', email: 'brand-b@example.com', password: 'secret123', phoneNumber: '+26878000302' });
    const tokenA = `Bearer ${signVendorToken(String(a._id))}`;

    await request(app).post('/api/tickets/social/follow')
      .set('Authorization', tokenA).send({ targetType: 'organizer', targetId: String(b._id) }).expect(200);

    const meA = await request(app).get('/api/tickets/social/me').set('Authorization', tokenA).expect(200);
    expect(meA.body.data.followingCount).toBe(1);

    const publicB = await request(app).get(`/api/public/organizers/${b._id}`).expect(200);
    expect(publicB.body.data.followerCount).toBe(1);
  });
});
