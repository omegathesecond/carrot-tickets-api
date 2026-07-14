import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';

describe('/api/tickets/dm (brand ↔ buyer)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const makeVendor = () =>
    Vendor.create({ businessName: 'Bhora Fest', email: 'dm-brand@example.com', phoneNumber: '+26878004001', password: 'secret123' });

  it('brand opens a thread with a buyer, both sides exchange messages', async () => {
    const brand = await makeVendor();
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Attendee', username: 'attendee_one' });
    const brandTok = `Bearer ${signVendorToken(String(brand._id))}`;
    const buyerTok = `Bearer ${signBuyerToken('+26878422613')}`;

    // Brand opens a 1:1 with the buyer.
    const open = await request(app).post('/api/tickets/dm/threads').set('Authorization', brandTok)
      .send({ buyerId: String(buyer._id) }).expect(201);
    const threadId = open.body.data.id;
    expect(open.body.data.participants.map((p: any) => p.id)).toEqual([String(buyer._id)]);

    // Idempotent: opening again returns the same thread.
    const open2 = await request(app).post('/api/tickets/dm/threads').set('Authorization', brandTok)
      .send({ buyerId: String(buyer._id) }).expect(201);
    expect(open2.body.data.id).toBe(threadId);

    // Brand sends a message.
    await request(app).post(`/api/tickets/dm/threads/${threadId}/messages`).set('Authorization', brandTok)
      .send({ body: 'Thanks for coming!' }).expect(201);

    // The buyer sees the thread (through the UNCHANGED buyer DM path) with the
    // brand as `organizer`, and can read + reply.
    const buyerThreads = await request(app).get('/api/dm/threads').set('Authorization', buyerTok).expect(200);
    const t = buyerThreads.body.data.find((x: any) => x.id === threadId);
    expect(t).toBeTruthy();
    expect(t.organizer?.businessName).toBe('Bhora Fest');

    const buyerMsgs = await request(app).get(`/api/dm/threads/${threadId}/messages`).set('Authorization', buyerTok).expect(200);
    expect(buyerMsgs.body.data.some((m: any) => m.body === 'Thanks for coming!')).toBe(true);

    await request(app).post(`/api/dm/threads/${threadId}/messages`).set('Authorization', buyerTok)
      .send({ body: 'See you there!' }).expect(201);

    // Brand sees the buyer's reply.
    const brandMsgs = await request(app).get(`/api/tickets/dm/threads/${threadId}/messages`).set('Authorization', brandTok).expect(200);
    expect(brandMsgs.body.data.some((m: any) => m.body === 'See you there!')).toBe(true);
  });

  it('401s a buyer token on the vendor DM route, 404s a foreign thread', async () => {
    await request(app).get('/api/tickets/dm/threads').set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
    const brand = await makeVendor();
    await request(app).get(`/api/tickets/dm/threads/${new mongoose.Types.ObjectId()}/messages`)
      .set('Authorization', `Bearer ${signVendorToken(String(brand._id))}`).expect(404);
  });
});
