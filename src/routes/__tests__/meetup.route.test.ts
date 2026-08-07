import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken } from '@/__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { MeetupRequest } from '@models/meetupRequest.model';

const auth = (phone: string) => ({ Authorization: `Bearer ${signBuyerToken(phone)}` });
const ME = '+26878422613';
const OTHER = '+26878000001';

describe('meetup routes', () => {
  beforeAll(async () => {
    await connectTestDb();
    await MeetupRequest.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('POST /meetups creates a pending request; target sees it in incoming?status=pending', async () => {
    await Buyer.create({ phone: ME, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: OTHER, password: 'secret1', name: 'T', username: 'target_a' });

    const created = await request(app)
      .post('/api/social/meetups')
      .set(auth(ME))
      .send({ targetId: String(target._id) })
      .expect(200);
    expect(created.body.data.status).toBe('pending');

    const incoming = await request(app)
      .get('/api/social/meetups/incoming?status=pending')
      .set(auth(OTHER))
      .expect(200);
    expect(incoming.body.data.meetups).toHaveLength(1);
    expect(incoming.body.data.meetups[0].user.username).toBe('me_one');
  });

  it('target accepts; requester cannot accept (403)', async () => {
    await Buyer.create({ phone: ME, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: OTHER, password: 'secret1', name: 'T', username: 'target_a' });
    const created = await request(app).post('/api/social/meetups').set(auth(ME)).send({ targetId: String(target._id) });
    const id = created.body.data.id;

    await request(app).post(`/api/social/meetups/${id}/accept`).set(auth(ME)).expect(403);
    await request(app).post(`/api/social/meetups/${id}/accept`).set(auth(OTHER)).expect(200);
    const row = await MeetupRequest.findById(id);
    expect(row!.status).toBe('accepted');
  });

  it('requester cancels a pending request', async () => {
    await Buyer.create({ phone: ME, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: OTHER, password: 'secret1', name: 'T', username: 'target_a' });
    const created = await request(app).post('/api/social/meetups').set(auth(ME)).send({ targetId: String(target._id) });
    await request(app).delete(`/api/social/meetups/${created.body.data.id}`).set(auth(ME)).expect(200);
    expect(await MeetupRequest.countDocuments({})).toBe(0);
  });

  it('rejects an invalid status filter', async () => {
    await Buyer.create({ phone: ME, password: 'secret1', name: 'Me', username: 'me_one' });
    await request(app).get('/api/social/meetups/incoming?status=bogus').set(auth(ME)).expect(400);
  });
});
