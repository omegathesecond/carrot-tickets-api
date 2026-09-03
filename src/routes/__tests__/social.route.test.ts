import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { StoryPointsAward } from '@models/storyPointsAward.model';

const PHONE = '+26878422613';

describe('social profile routes', () => {
  // The "taken username" case below asserts a 409, which the controller only
  // produces from Mongo's duplicate-key error (E11000) — the same race-free
  // path used in production. That error can only fire once the unique index on
  // Buyer.username actually exists, and Mongoose builds indexes in the
  // background, so awaiting init() here establishes the precondition instead of
  // racing it (without this the duplicate silently succeeds and returns 200).
  beforeAll(async () => {
    await connectTestDb();
    await Buyer.init();
  });
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
    expect(res.body.data.storyPoints).toBe(0);
    expect(JSON.stringify(res.body.data)).not.toContain(PHONE); // no phone leak
  });

  it('GET /me sums storyPoints from the persisted award ledger, not from live Story docs', async () => {
    const buyer = await seedBuyer();
    await StoryPointsAward.create([
      { buyerId: buyer._id, storyId: new mongoose.Types.ObjectId(), points: 25 },
      { buyerId: buyer._id, storyId: new mongoose.Types.ObjectId(), points: 25 },
    ]);
    const res = await request(app)
      .get('/api/social/me')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);
    expect(res.body.data.storyPoints).toBe(50);
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
    // Spaces are never in-alphabet, so they 400 the same as any other
    // disallowed character — no dedicated space check needed.
    await request(app).patch('/api/social/me').set('Authorization', auth).send({ username: 'has space' }).expect(400);
  });

  it('accepts full stops in a username (letters, numbers, underscores and full stops only)', async () => {
    await seedBuyer();
    const res = await request(app)
      .patch('/api/social/me')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ username: 'laslie.g_2' })
      .expect(200);
    expect(res.body.data.username).toBe('laslie.g_2');
  });

  it('PATCH /me sets the profile name on first change, with no cooldown yet applied', async () => {
    await seedBuyer(PHONE, { name: 'Old Name' });
    const res = await request(app)
      .patch('/api/social/me')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ name: 'New Name' })
      .expect(200);

    expect(res.body.data.name).toBe('New Name');
    // Just changed it, so the 30-day cooldown is now active.
    expect(res.body.data.nextNameChangeAt).not.toBeNull();
  });

  it('blocks a second profile-name change within 30 days, keeps the existing name, and names the retry date', async () => {
    const buyer = await seedBuyer(PHONE, { name: 'Old Name' });
    buyer.name = 'First Change';
    buyer.nameChangedAt = new Date('2026-08-20T00:00:00.000Z'); // 14 days before "now" in these tests
    await buyer.save();

    const res = await request(app)
      .patch('/api/social/me')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ name: 'Second Change' })
      .expect(409);

    expect(res.body.message).toMatch(/^You can change your profile name again on .+\.$/);
    const stored = await Buyer.findById(buyer._id);
    expect(stored?.name).toBe('First Change'); // unchanged
  });

  it('allows a profile-name change again once 30 days have passed', async () => {
    const buyer = await seedBuyer(PHONE, { name: 'Old Name' });
    buyer.name = 'First Change';
    buyer.nameChangedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await buyer.save();

    const res = await request(app)
      .patch('/api/social/me')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ name: 'Second Change' })
      .expect(200);

    expect(res.body.data.name).toBe('Second Change');
  });

  it('re-saving the same profile name is a no-op — does not consume the cooldown', async () => {
    const buyer = await seedBuyer(PHONE, { name: 'Same Name' });
    const res = await request(app)
      .patch('/api/social/me')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ name: 'Same Name', bio: 'unrelated update' })
      .expect(200);

    expect(res.body.data.name).toBe('Same Name');
    expect(res.body.data.nextNameChangeAt).toBeNull();
    expect(res.body.data.bio).toBe('unrelated update');
    const stored = await Buyer.findById(buyer._id);
    expect(stored?.nameChangedAt).toBeUndefined();
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
