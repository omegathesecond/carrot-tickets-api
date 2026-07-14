import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

describe('block enforcement on brand↔buyer DMs', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const seed = async () => {
    const brand = await Vendor.create({ businessName: 'Blocky', email: 'blk@example.com', phoneNumber: '+26878005001', password: 'secret123' });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'B', username: 'blk_buyer' });
    return { brand, buyer, brandTok: `Bearer ${signVendorToken(String(brand._id))}`, buyerTok: `Bearer ${signBuyerToken('+26878422613')}` };
  };

  it('a buyer who blocks the brand stops the brand from messaging + opening', async () => {
    const { brand, buyer, brandTok, buyerTok } = await seed();
    const open = await request(app).post('/api/tickets/dm/threads').set('Authorization', brandTok).send({ buyerId: String(buyer._id) }).expect(201);
    const threadId = open.body.data.id;

    // Buyer blocks the brand (existing buyer endpoint, now accepts a vendor target).
    await request(app).post('/api/social/block').set('Authorization', buyerTok).send({ userId: String(brand._id) }).expect(200);

    // Brand can no longer send, nor re-open.
    await request(app).post(`/api/tickets/dm/threads/${threadId}/messages`).set('Authorization', brandTok).send({ body: 'hi' }).expect(403);
    await request(app).post('/api/tickets/dm/threads').set('Authorization', brandTok).send({ buyerId: String(buyer._id) }).expect(403);
  });

  it('a brand that blocks a buyer stops the buyer from messaging', async () => {
    const { brand, buyer, brandTok, buyerTok } = await seed();
    const open = await request(app).post('/api/tickets/dm/threads').set('Authorization', brandTok).send({ buyerId: String(buyer._id) }).expect(201);
    const threadId = open.body.data.id;

    await request(app).post('/api/tickets/social/block').set('Authorization', brandTok).send({ userId: String(buyer._id) }).expect(200);

    await request(app).post(`/api/dm/threads/${threadId}/messages`).set('Authorization', buyerTok).send({ body: 'yo' }).expect(403);
  });
});
