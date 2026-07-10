import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { PushSubscription } from '@models/pushSubscription.model';

const PHONE = '+26878422613';
const SUB = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };

describe('push subscribe routes', () => {
  beforeAll(async () => {
    await connectTestDb();
    await PushSubscription.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('vapid key available; subscribe upserts; endpoint reassigns to current buyer; unsubscribe own only', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1' });
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    const key = await request(app).get('/api/social/push/vapid-public-key').set('Authorization', auth).expect(200);
    expect(key.body.data.key).toBeTruthy();

    await request(app).post('/api/social/push/subscribe').set('Authorization', auth).send(SUB).expect(200);
    await request(app).post('/api/social/push/subscribe').set('Authorization', auth).send(SUB).expect(200);
    expect(await PushSubscription.countDocuments({})).toBe(1);

    const other = await Buyer.create({ phone: '+26878000042', password: 'secret1' });
    const otherAuth = `Bearer ${signBuyerToken('+26878000042')}`;
    await request(app).post('/api/social/push/subscribe').set('Authorization', otherAuth).send(SUB).expect(200);
    const row = await PushSubscription.findOne({ endpoint: SUB.endpoint });
    expect(String(row!.buyerId)).toBe(String(other._id));

    // first buyer can no longer delete it (not theirs anymore)
    await request(app).delete('/api/social/push/subscribe').set('Authorization', auth)
      .send({ endpoint: SUB.endpoint }).expect(200);
    expect(await PushSubscription.countDocuments({})).toBe(1);

    await request(app).delete('/api/social/push/subscribe').set('Authorization', otherAuth)
      .send({ endpoint: SUB.endpoint }).expect(200);
    expect(await PushSubscription.countDocuments({})).toBe(0);

    await request(app).post('/api/social/push/subscribe').set('Authorization', auth)
      .send({ endpoint: 'http://insecure.example', keys: SUB.keys }).expect(400);
  });
});
