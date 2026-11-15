import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerSessionToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';

describe('onboarding people pagination', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);
  it('reaches beyond 200 candidates, rotates by seed, and does not skip people after follows', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', username: 'viewer', avatarUrl: 'photo' });
    await Buyer.insertMany(Array.from({ length: 225 }, (_, i) => ({ phone: `+26879${String(i).padStart(6, '0')}`, username: `person_${i}`, avatarUrl: 'photo' })));
    const token = await signBuyerSessionToken('+26878422613');
    const page = async (n: number, seed = 123) => (await request(app).get(`/api/social/onboarding/people?page=${n}&limit=20&seed=${seed}`).set('Authorization', `Bearer ${token}`).expect(200)).body.data;
    const first = await page(1);
    expect(first.people).toHaveLength(20);
    expect((await page(1, 456)).people.map((p: { id: string }) => p.id)).not.toEqual(first.people.map((p: { id: string }) => p.id));
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: first.people[0].id });
    expect((await page(1)).people.map((p: { id: string }) => p.id)).not.toContain(first.people[0].id);
    const ids = first.people.map((p: { id: string }) => p.id);
    let more = first.hasMore;
    for (let n = 2; more; n++) {
      const result = await page(n);
      ids.push(...result.people.map((p: { id: string }) => p.id));
      more = result.hasMore;
      expect(n).toBeLessThan(20);
    }
    expect(ids).toHaveLength(225);
    expect(new Set(ids).size).toBe(225);
    expect(ids).not.toContain(String(me._id));
  });
});
