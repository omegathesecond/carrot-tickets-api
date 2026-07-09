import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';

const PHONE = '+26878422613';

describe('social profile routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedBuyer(phone = PHONE, extra: Record<string, unknown> = {}) {
    return Buyer.create({ phone, password: 'secret1', name: 'Test Buyer', ...extra });
  }

  it('GET /me lazily assigns a username', async () => {
    await seedBuyer();
    const res = await request(app)
      .get('/api/social/me')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    expect(res.body.data.username).toMatch(/^[a-z0-9_]{3,20}$/);
    expect(res.body.data.usernameCustomized).toBe(false);
    expect(res.body.data.dmPrivacy).toBe('community');
    expect(JSON.stringify(res.body.data)).not.toContain(PHONE); // no phone leak
  });

  it('PATCH /me sets a custom username, bio and dmPrivacy', async () => {
    await seedBuyer();
    const res = await request(app)
      .patch('/api/social/me')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ username: 'laslie_g', bio: 'festival fan', dmPrivacy: 'friends' })
      .expect(200);

    expect(res.body.data.username).toBe('laslie_g');
    expect(res.body.data.usernameCustomized).toBe(true);
    expect(res.body.data.bio).toBe('festival fan');
    expect(res.body.data.dmPrivacy).toBe('friends');
  });

  it('rejects invalid, reserved and taken usernames', async () => {
    await seedBuyer();
    await seedBuyer('+26878000050', { username: 'taken_name' });
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    await request(app).patch('/api/social/me').set('Authorization', auth).send({ username: 'X' }).expect(400);
    await request(app).patch('/api/social/me').set('Authorization', auth).send({ username: 'admin' }).expect(409);
    await request(app).patch('/api/social/me').set('Authorization', auth).send({ username: 'taken_name' }).expect(409);
  });

  it('public profile by username hides the phone', async () => {
    await seedBuyer(PHONE, { username: 'partygoer', bio: 'hey' });
    await seedBuyer('+26878000051'); // the viewer
    const res = await request(app)
      .get('/api/social/users/partygoer')
      .set('Authorization', `Bearer ${signBuyerToken('+26878000051')}`)
      .expect(200);

    expect(res.body.data.username).toBe('partygoer');
    expect(res.body.data.bio).toBe('hey');
    expect(JSON.stringify(res.body.data)).not.toContain(PHONE);
    expect(res.body.data.dmPrivacy).toBeUndefined(); // own-profile field only
  });

  it('unknown username is 404', async () => {
    await seedBuyer();
    await request(app)
      .get('/api/social/users/ghost_user')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(404);
  });

  it('username-available reflects reserved/taken/free', async () => {
    await seedBuyer(PHONE, { username: 'partygoer' });
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    const taken = await request(app).get('/api/social/username-available?u=partygoer').set('Authorization', auth).expect(200);
    expect(taken.body.data.available).toBe(false);

    const reserved = await request(app).get('/api/social/username-available?u=admin').set('Authorization', auth).expect(200);
    expect(reserved.body.data.available).toBe(false);

    const free = await request(app).get('/api/social/username-available?u=fresh_handle').set('Authorization', auth).expect(200);
    expect(free.body.data.available).toBe(true);
  });
});
