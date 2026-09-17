import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';

const PHONE = '+26878422613';

async function seedBuyer(phone = PHONE, username = 'weekend_route_buyer') {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', username });
}

describe('Weekend routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('auth guards', () => {
    it('401s GET /me when signed out', async () => {
      await request(app).get('/api/social/weekend/me').expect(401);
    });

    it('401s PUT /me when signed out', async () => {
      await request(app).put('/api/social/weekend/me').send({ statusType: 'bored' }).expect(401);
    });

    it('401s DELETE /me when signed out', async () => {
      await request(app).delete('/api/social/weekend/me').expect(401);
    });

    it('401s POST /media when signed out', async () => {
      await request(app).post('/api/social/weekend/media').send({ contentType: 'image/jpeg' }).expect(401);
    });

    it('401s POST /requests when signed out', async () => {
      await request(app)
        .post('/api/social/weekend/requests')
        .send({ recipientId: String(new mongoose.Types.ObjectId()), kind: 'request_to_meet' })
        .expect(401);
    });

    it('401s GET /requests when signed out', async () => {
      await request(app).get('/api/social/weekend/requests').expect(401);
    });

    it('401s POST /requests/:id/accept and /decline when signed out', async () => {
      const fakeId = String(new mongoose.Types.ObjectId());
      await request(app).post(`/api/social/weekend/requests/${fakeId}/accept`).expect(401);
      await request(app).post(`/api/social/weekend/requests/${fakeId}/decline`).expect(401);
    });

    it('401s DELETE /requests/:id when signed out', async () => {
      await request(app).delete(`/api/social/weekend/requests/${String(new mongoose.Types.ObjectId())}`).expect(401);
    });
  });

  describe('public routes work signed-out', () => {
    it('GET /feed returns 200 with no auth', async () => {
      const res = await request(app).get('/api/social/weekend/feed').expect(200);
      expect(res.body.data.cards).toEqual([]);
    });

    it('GET /feed/looking-for-plans returns 200 with no auth', async () => {
      const res = await request(app).get('/api/social/weekend/feed/looking-for-plans').expect(200);
      expect(res.body.data.cards).toEqual([]);
    });

    it('GET /feed/all returns 200 with no auth, paginated with a nextCursor', async () => {
      const res = await request(app).get('/api/social/weekend/feed/all').expect(200);
      expect(res.body.data).toEqual({ cards: [], nextCursor: null });
    });

    it('GET /users/:username returns 200 with no auth for an existing user with no status', async () => {
      const buyer = await seedBuyer();
      const res = await request(app).get(`/api/social/weekend/users/${buyer.username}`).expect(200);
      expect(res.body.data).toEqual({ username: buyer.username, hasStatus: false, status: null });
    });

    it('GET /users/:username 404s for an unknown username, even signed out', async () => {
      await request(app).get('/api/social/weekend/users/no_such_user_at_all').expect(404);
    });
  });

  describe('authenticated round trip', () => {
    it('lets a signed-in buyer set, read back, and remove their own status', async () => {
      await seedBuyer();
      const auth = `Bearer ${signBuyerToken(PHONE)}`;

      const put = await request(app)
        .put('/api/social/weekend/me')
        .set('Authorization', auth)
        .send({ statusType: 'bored', audience: 'public' })
        .expect(200);
      expect(put.body.data.status.statusType).toBe('bored');

      const get = await request(app).get('/api/social/weekend/me').set('Authorization', auth).expect(200);
      expect(get.body.data.status.statusType).toBe('bored');

      await request(app).delete('/api/social/weekend/me').set('Authorization', auth).expect(200);
      const after = await request(app).get('/api/social/weekend/me').set('Authorization', auth).expect(200);
      expect(after.body.data.status).toBeNull();
    });

    it('presigns a photo upload then accepts its returned url as the status media', async () => {
      const OLD_ENV = process.env;
      process.env = {
        ...OLD_ENV,
        UPDATES_R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
        UPDATES_R2_ACCESS_KEY_ID: 'test-key',
        UPDATES_R2_SECRET_ACCESS_KEY: 'test-secret',
        UPDATES_R2_BUCKET_NAME: 'updates-test',
        UPDATES_R2_PUBLIC_URL: 'https://cdn.carrottickets.com',
      };
      try {
        await seedBuyer();
        const auth = `Bearer ${signBuyerToken(PHONE)}`;

        const rejected = await request(app)
          .post('/api/social/weekend/media')
          .set('Authorization', auth)
          .send({ contentType: 'video/mp4' })
          .expect(400);
        expect(rejected.body.success).toBe(false);

        const presign = await request(app)
          .post('/api/social/weekend/media')
          .set('Authorization', auth)
          .send({ contentType: 'image/jpeg' })
          .expect(200);
        const { publicUrl } = presign.body.data;
        expect(publicUrl).toContain('https://cdn.carrottickets.com/updates/raw/');

        const put = await request(app)
          .put('/api/social/weekend/me')
          .set('Authorization', auth)
          .send({ statusType: 'bored', media: { url: publicUrl, width: 400, height: 300 } })
          .expect(200);
        expect(put.body.data.status.media).toEqual({ url: publicUrl, width: 400, height: 300 });
      } finally {
        process.env = OLD_ENV;
      }
    });

    it('surfaces a just-created status as the first, isOwner card in the "Who Has Plans" feed and See All page', async () => {
      await seedBuyer();
      const auth = `Bearer ${signBuyerToken(PHONE)}`;

      await request(app)
        .put('/api/social/weekend/me')
        .set('Authorization', auth)
        .send({ statusType: 'have_plans', audience: 'public' })
        .expect(200);

      const feed = await request(app).get('/api/social/weekend/feed').set('Authorization', auth).expect(200);
      expect(feed.body.data.cards[0]?.user.username).toBe('weekend_route_buyer');
      expect(feed.body.data.cards[0]?.isOwner).toBe(true);

      const seeAll = await request(app).get('/api/social/weekend/feed/all').set('Authorization', auth).expect(200);
      expect(seeAll.body.data.cards[0]?.user.username).toBe('weekend_route_buyer');
      expect(seeAll.body.data.cards[0]?.isOwner).toBe(true);

      // Updating (not duplicating) the status: still exactly one card for this buyer.
      await request(app)
        .put('/api/social/weekend/me')
        .set('Authorization', auth)
        .send({ statusType: 'bored', audience: 'public' })
        .expect(200);
      const refeed = await request(app).get('/api/social/weekend/feed').set('Authorization', auth).expect(200);
      expect(refeed.body.data.cards.filter((c: any) => c.user.username === 'weekend_route_buyer')).toHaveLength(1);
      expect(refeed.body.data.cards[0]?.statusType).toBe('bored');
    });
  });
});
