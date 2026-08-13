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

  it('POST /meetups creates a pending request; target sees it as an incoming row, requester as outgoing', async () => {
    await Buyer.create({ phone: ME, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: OTHER, password: 'secret1', name: 'T', username: 'target_a' });

    const created = await request(app)
      .post('/api/social/meetups')
      .set(auth(ME))
      .send({ targetId: String(target._id) })
      .expect(200);
    expect(created.body.data.status).toBe('pending');

    // Target's Requested tab: one incoming row from me_one.
    const incoming = await request(app)
      .get('/api/social/meetups?status=pending')
      .set(auth(OTHER))
      .expect(200);
    expect(incoming.body.data.meetups).toHaveLength(1);
    expect(incoming.body.data.meetups[0].direction).toBe('incoming');
    expect(incoming.body.data.meetups[0].user.username).toBe('me_one');

    // Requester's Requested tab: the SAME request, now as an outgoing row.
    const outgoing = await request(app)
      .get('/api/social/meetups?status=pending')
      .set(auth(ME))
      .expect(200);
    expect(outgoing.body.data.meetups).toHaveLength(1);
    expect(outgoing.body.data.meetups[0].direction).toBe('outgoing');
    expect(outgoing.body.data.meetups[0].user.username).toBe('target_a');
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
    await request(app).get('/api/social/meetups?status=bogus').set(auth(ME)).expect(400);
  });

  it('GET /meetups?status=accepted returns accepted meetups in both directions', async () => {
    const me = await Buyer.create({ phone: ME, password: 'secret1', name: 'Me', username: 'me_one' });
    const A = await Buyer.create({ phone: OTHER, password: 'secret1', name: 'A', username: 'user_a' });
    const B = await Buyer.create({ phone: '+26878000002', password: 'secret1', name: 'B', username: 'user_b' });

    // Direction 1: viewer (ME) is the requester, A accepts.
    const req1 = await request(app).post('/api/social/meetups').set(auth(ME)).send({ targetId: String(A._id) });
    await request(app).post(`/api/social/meetups/${req1.body.data.id}/accept`).set(auth(OTHER)).expect(200);

    // Direction 2: viewer (ME) is the target, B requests and ME accepts.
    const req2 = await request(app)
      .post('/api/social/meetups')
      .set(auth('+26878000002'))
      .send({ targetId: String(me._id) });
    await request(app).post(`/api/social/meetups/${req2.body.data.id}/accept`).set(auth(ME)).expect(200);

    const res = await request(app).get('/api/social/meetups?status=accepted').set(auth(ME)).expect(200);
    const ids = res.body.data.meetups.map((m: any) => m.user.id).sort();
    expect(ids).toEqual([String(A._id), String(B._id)].sort());
  });

  it('GET /meetups?status=declined surfaces outgoing-declined to the requester', async () => {
    await Buyer.create({ phone: ME, password: 'secret1', name: 'Me', username: 'me_one' });
    const target = await Buyer.create({ phone: OTHER, password: 'secret1', name: 'T', username: 'target_a' });
    const created = await request(app).post('/api/social/meetups').set(auth(ME)).send({ targetId: String(target._id) });
    await request(app).post(`/api/social/meetups/${created.body.data.id}/decline`).set(auth(OTHER)).expect(200);

    const res = await request(app).get('/api/social/meetups?status=declined').set(auth(ME)).expect(200);
    expect(res.body.data.meetups).toHaveLength(1);
    expect(res.body.data.meetups[0].direction).toBe('outgoing');
    expect(res.body.data.meetups[0].user.username).toBe('target_a');
  });
});
