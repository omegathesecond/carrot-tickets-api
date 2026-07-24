import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';

const PHONE = '+26878422613';

describe('PATCH/DELETE /api/social/me/location', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Buyer.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('sets location + locationUpdatedAt on PATCH (the opt-in)', async () => {
    const me = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    expect(me.location).toBeUndefined();

    const res = await request(app)
      .patch('/api/social/me/location')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ lat: -26.3054, lng: 31.1367 })
      .expect(200);

    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.location).toEqual({ type: 'Point', coordinates: [31.1367, -26.3054] });

    const fresh = await Buyer.findById(me._id);
    expect(fresh?.location?.type).toBe('Point');
    expect(fresh?.location?.coordinates).toEqual([31.1367, -26.3054]);
    expect(fresh?.locationUpdatedAt).toBeInstanceOf(Date);
  });

  it('rejects an out-of-range lat with 400', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    await request(app)
      .patch('/api/social/me/location')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ lat: 91, lng: 31.1367 })
      .expect(400);
  });

  it('rejects an out-of-range lng with 400', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    await request(app)
      .patch('/api/social/me/location')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ lat: -26.3054, lng: 181 })
      .expect(400);
  });

  it('rejects a missing lat/lng with 400', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me', username: 'me_one' });
    await request(app)
      .patch('/api/social/me/location')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ lat: -26.3054 })
      .expect(400);
  });

  it('401s when anonymous', async () => {
    await request(app).patch('/api/social/me/location').send({ lat: 1, lng: 1 }).expect(401);
  });

  it('unsets location + locationUpdatedAt on DELETE (the opt-out)', async () => {
    const me = await Buyer.create({
      phone: PHONE,
      password: 'secret1',
      name: 'Me',
      username: 'me_one',
      location: { type: 'Point', coordinates: [31.1367, -26.3054] },
      locationUpdatedAt: new Date(),
    });

    const res = await request(app)
      .delete('/api/social/me/location')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);
    expect(res.body.data.ok).toBe(true);

    const fresh = await Buyer.findById(me._id);
    expect(fresh?.location).toBeUndefined();
    expect(fresh?.locationUpdatedAt).toBeUndefined();
  });

  it('401s DELETE when anonymous', async () => {
    await request(app).delete('/api/social/me/location').expect(401);
  });
});
