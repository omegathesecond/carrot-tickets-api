import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

let vseq = 0;
const makeVendor = () => {
  vseq += 1;
  return Vendor.create({ businessName: `Brand ${vseq}`, email: `vendor${vseq}@example.com`, phoneNumber: `+2687${8100000 + vseq}`, password: 'secret123' });
};

describe('/api/tickets/social/me/following|followers (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('following lists the buyers and brands the vendor follows', async () => {
    const me = await makeVendor();
    const followedBrand = await makeVendor();
    const followedBuyer = await Buyer.create({ phone: '+26878000601', password: 'secret1', name: 'Alice', username: 'alice_ff' });
    const token = `Bearer ${signVendorToken(String(me._id))}`;

    await request(app).post('/api/tickets/social/follow').set('Authorization', token).send({ targetType: 'organizer', targetId: String(followedBrand._id) }).expect(200);
    await request(app).post('/api/tickets/social/follow').set('Authorization', token).send({ targetType: 'buyer', targetId: String(followedBuyer._id) }).expect(200);

    const res = await request(app).get('/api/tickets/social/me/following').set('Authorization', token).expect(200);
    expect(res.body.data.organizers.map((o: any) => o.id)).toEqual([String(followedBrand._id)]);
    expect(res.body.data.buyers.map((b: any) => b.id)).toEqual([String(followedBuyer._id)]);
    expect(res.body.data.buyers[0]).not.toHaveProperty('phone');
  });

  it('followers lists buyers and brands that follow the vendor', async () => {
    const me = await makeVendor();
    const followerBrand = await makeVendor();
    const followerBuyer = await Buyer.create({ phone: '+26878000602', password: 'secret1', name: 'Bob' });

    // buyer follows me (buyer route resolves the buyer from the token phone)
    await request(app).post('/api/social/follow').set('Authorization', `Bearer ${signBuyerToken('+26878000602')}`).send({ targetType: 'organizer', targetId: String(me._id) }).expect(200);
    // brand follows me (vendor route)
    await request(app).post('/api/tickets/social/follow').set('Authorization', `Bearer ${signVendorToken(String(followerBrand._id))}`).send({ targetType: 'organizer', targetId: String(me._id) }).expect(200);

    const res = await request(app).get('/api/tickets/social/me/followers').set('Authorization', `Bearer ${signVendorToken(String(me._id))}`).expect(200);
    expect(res.body.data.organizers.map((o: any) => o.id)).toEqual([String(followerBrand._id)]);
    expect(res.body.data.buyers.map((b: any) => b.id)).toEqual([String(followerBuyer._id)]);
  });
});
