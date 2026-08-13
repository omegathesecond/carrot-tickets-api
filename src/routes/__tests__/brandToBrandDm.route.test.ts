import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { DmThread } from '@models/dmThread.model';
import { BlockService } from '@services/block.service';
import { resetBuckets } from '@utils/rateLimit.util';

describe('/api/tickets/dm/brand-threads (brand ↔ brand)', () => {
  beforeAll(async () => {
    await connectTestDb();
    await DmThread.init(); // unique brandPairKey index must exist before dedupe races it
  });
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const makeVendor = (name: string, phone: string, email: string, extra: Record<string, unknown> = {}) =>
    Vendor.create({ businessName: name, email, phoneNumber: phone, password: 'secret123', ...extra });

  async function two() {
    const a = await makeVendor('Alpha Events', '+26878004001', 'a@example.com');
    const b = await makeVendor('Beta Shows', '+26878004002', 'b@example.com');
    return { a, b, tokA: `Bearer ${signVendorToken(String(a._id))}`, tokB: `Bearer ${signVendorToken(String(b._id))}` };
  }

  it('a brand opens a 1:1 with another brand; the view names the OTHER brand, no contact leaks', async () => {
    const { b, tokA } = await two();
    const res = await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: String(b._id) }).expect(201);
    expect(res.body.data.organizer).toMatchObject({ id: String(b._id), businessName: 'Beta Shows' });
    expect(res.body.data.participants).toEqual([]); // no buyer party
    expect(JSON.stringify(res.body.data)).not.toContain('b@example.com');
  });

  it('dedupes order-independently: A→B and B→A resolve to ONE thread', async () => {
    const { a, b, tokA, tokB } = await two();
    const r1 = await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: String(b._id) }).expect(201);
    const r2 = await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokB)
      .send({ vendorId: String(a._id) }).expect(201);
    expect(r2.body.data.id).toBe(r1.body.data.id);
    expect(await DmThread.countDocuments({})).toBe(1);
    // Each side sees the OTHER brand as the counterparty.
    expect(r1.body.data.organizer.businessName).toBe('Beta Shows');
    expect(r2.body.data.organizer.businessName).toBe('Alpha Events');
  });

  it('both brands exchange messages; sender.id distinguishes them (both are "organizer")', async () => {
    const { a, b, tokA, tokB } = await two();
    const threadId = (await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: String(b._id) }).expect(201)).body.data.id;

    await request(app).post(`/api/tickets/dm/threads/${threadId}/messages`).set('Authorization', tokA)
      .send({ body: 'Hi Beta' }).expect(201);
    await request(app).post(`/api/tickets/dm/threads/${threadId}/messages`).set('Authorization', tokB)
      .send({ body: 'Hey Alpha' }).expect(201);

    // B lists threads → sees A as counterparty + unread (own sends never count).
    const listB = await request(app).get('/api/tickets/dm/threads').set('Authorization', tokB).expect(200);
    const tB = listB.body.data.find((x: any) => x.id === threadId);
    expect(tB.organizer.businessName).toBe('Alpha Events');

    const msgsB = await request(app).get(`/api/tickets/dm/threads/${threadId}/messages`).set('Authorization', tokB).expect(200);
    const byBody: Record<string, any> = Object.fromEntries(msgsB.body.data.map((m: any) => [m.body, m]));
    expect(byBody['Hi Beta'].senderType).toBe('organizer');
    expect(byBody['Hi Beta'].sender.id).toBe(String(a._id));
    expect(byBody['Hey Alpha'].sender.id).toBe(String(b._id)); // both organizer, told apart by id
  });

  it('self 400, malformed 400, unknown 404, inactive 404', async () => {
    const { a, tokA } = await two();
    await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: String(a._id) }).expect(400);
    await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: 'nope' }).expect(400);
    await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }).expect(404);
    const inactive = await makeVendor('Gone', '+26878004009', 'gone@example.com', { isActive: false });
    await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: String(inactive._id) }).expect(404);
  });

  it('a block (either direction) refuses the thread (403)', async () => {
    const { a, b, tokA } = await two();
    await BlockService.blockAsVendor(String(a._id), String(b._id));
    await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: String(b._id) }).expect(403);
  });

  it('a non-party brand cannot read the thread (404 hides existence)', async () => {
    const { b, tokA } = await two();
    const threadId = (await request(app).post('/api/tickets/dm/brand-threads').set('Authorization', tokA)
      .send({ vendorId: String(b._id) }).expect(201)).body.data.id;
    const outsider = await makeVendor('Nosy', '+26878004003', 'nosy@example.com');
    await request(app).get(`/api/tickets/dm/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${signVendorToken(String(outsider._id))}`).expect(404);
  });
});
