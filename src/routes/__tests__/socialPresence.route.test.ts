import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { BuyerPresence } from '@models/buyerPresence.model';
import { PRESENCE_STALE_MS } from '@utils/buyerOnline.util';

const PHONE = '+26878422613';

describe('POST /api/social/presence', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedBuyer(phone: string, extra: Record<string, unknown> = {}) {
    return Buyer.create({ phone, password: 'secret1', name: 'Test Buyer', ...extra });
  }

  it('returns only the online subset: fresh presence in, stale/absent excluded', async () => {
    const me = await seedBuyer(PHONE);
    const online = await seedBuyer('+26878000042');
    const stale = await seedBuyer('+26878000043');
    const absent = await seedBuyer('+26878000044');

    await BuyerPresence.create({
      buyerId: online._id,
      socketId: 'socket-online',
      instanceId: 'instance-1',
      lastSeenAt: new Date(),
    });
    await BuyerPresence.create({
      buyerId: stale._id,
      socketId: 'socket-stale',
      instanceId: 'instance-1',
      lastSeenAt: new Date(Date.now() - PRESENCE_STALE_MS - 1000),
    });
    // absent buyer has no BuyerPresence row at all

    const res = await request(app)
      .post('/api/social/presence')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ buyerIds: [String(online._id), String(stale._id), String(absent._id)] })
      .expect(200);

    expect(res.body.data.online).toEqual([String(online._id)]);
  });

  it('rejects more than 50 buyerIds', async () => {
    await seedBuyer(PHONE);
    const ids = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(24, '0'));

    await request(app)
      .post('/api/social/presence')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ buyerIds: ids })
      .expect(400);
  });

  it('rejects an empty buyerIds array', async () => {
    await seedBuyer(PHONE);

    await request(app)
      .post('/api/social/presence')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ buyerIds: [] })
      .expect(400);
  });

  it('requires authentication', async () => {
    await request(app)
      .post('/api/social/presence')
      .send({ buyerIds: ['507f1f77bcf86cd799439011'] })
      .expect(401);
  });
});
