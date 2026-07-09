import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { BlockService } from '@services/block.service';

const PHONE_A = '+26878422613';
const PHONE_B = '+26878000042';

describe('block routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seed() {
    const a = await Buyer.create({ phone: PHONE_A, password: 'secret1', name: 'Alpha' });
    const b = await Buyer.create({ phone: PHONE_B, password: 'secret1', name: 'Beta' });
    return { a, b, authA: `Bearer ${signBuyerToken(PHONE_A)}` };
  }

  it('block, list, unblock round-trip (idempotent)', async () => {
    const { a, b, authA } = await seed();

    await request(app).post('/api/social/block').set('Authorization', authA).send({ userId: String(b._id) }).expect(200);
    await request(app).post('/api/social/block').set('Authorization', authA).send({ userId: String(b._id) }).expect(200);

    const list = await request(app).get('/api/social/me/blocks').set('Authorization', authA).expect(200);
    expect(list.body.data.userIds).toEqual([String(b._id)]);
    expect(await BlockService.isBlockedEitherWay(String(a._id), String(b._id))).toBe(true);
    expect(await BlockService.isBlockedEitherWay(String(b._id), String(a._id))).toBe(true);

    await request(app).delete(`/api/social/block/${String(b._id)}`).set('Authorization', authA).expect(200);
    await request(app).delete(`/api/social/block/${String(b._id)}`).set('Authorization', authA).expect(200);
    const after = await request(app).get('/api/social/me/blocks').set('Authorization', authA).expect(200);
    expect(after.body.data.userIds).toEqual([]);
  });

  it('rejects self-block (400), unknown user (404), bad id (400), no auth (401)', async () => {
    const { a, authA } = await seed();
    await request(app).post('/api/social/block').set('Authorization', authA).send({ userId: String(a._id) }).expect(400);
    await request(app).post('/api/social/block').set('Authorization', authA).send({ userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }).expect(404);
    await request(app).post('/api/social/block').set('Authorization', authA).send({ userId: 'nope' }).expect(400);
    await request(app).post('/api/social/block').send({ userId: String(a._id) }).expect(401);
  });
});
