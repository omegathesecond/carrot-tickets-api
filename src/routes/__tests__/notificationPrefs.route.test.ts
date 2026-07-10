import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';

const PHONE = '+26878422613';

describe('notification preferences', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('defaults all true; partial PATCH merges; me echoes them', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', username: 'prefs_user' });
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    let me = await request(app).get('/api/social/me').set('Authorization', auth).expect(200);
    expect(me.body.data.notificationPrefs).toEqual({
      announcements: true, dms: true, mentions: true, social: true, reminders: true,
    });

    await request(app).patch('/api/social/me').set('Authorization', auth)
      .send({ notificationPrefs: { dms: false, reminders: false } }).expect(200);

    me = await request(app).get('/api/social/me').set('Authorization', auth).expect(200);
    expect(me.body.data.notificationPrefs).toEqual({
      announcements: true, dms: false, mentions: true, social: true, reminders: false,
    });

    await request(app).patch('/api/social/me').set('Authorization', auth)
      .send({ notificationPrefs: { unknown_key: false } }).expect(400);
    await request(app).patch('/api/social/me').set('Authorization', auth)
      .send({ notificationPrefs: {} }).expect(400);
  });
});
