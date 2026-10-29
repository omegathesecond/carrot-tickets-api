import request, { Response } from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerSessionToken } from '../../__tests__/helpers/auth';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { WeekendService } from '@services/weekend.service';
import { Vendor } from '@models/vendor.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { signVendorToken, signVendorSessionToken, signStaffSessionToken } from '../../__tests__/helpers/auth';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { updatesR2 } from '@utils/updatesR2';
import { Buyer } from '@models/buyer.model';

const PHONE = '+26878422613';

async function seedBuyer(phone = PHONE, username = 'weekend_route_buyer') {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', username });
}

describe('Weekend routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('serves public plans and profile media to regular, provider, organiser and admin accounts', async () => {
    const buyer = await seedBuyer();
    const previousBase = process.env['UPDATES_R2_PUBLIC_URL'];
    process.env['UPDATES_R2_PUBLIC_URL'] = 'https://cdn.carrottickets.com';
    try {
      const plan = await WeekendService.createPlan(buyer, { statusType: 'have_plans', media: [{ url: 'https://cdn.carrottickets.com/plan.jpg', type: 'image' }] });
      const otherBuyer = await seedBuyer('+26878422614', 'other_weekend_user');
      const plans = [plan];
      for (const statusType of ['custom', 'staying_in', 'bored', 'nothing_planned'] as const) {
        plans.push(await WeekendService.createPlan(otherBuyer, { statusType, message: 'A posted plan', media: [{ url: 'https://cdn.carrottickets.com/plan.jpg', type: 'image' }] }));
      }
      const buyerToken = await signBuyerSessionToken(PHONE);
      const tokens = [buyerToken];
      for (const [index, operatorType] of [OperatorType.SERVICES, OperatorType.EVENTS, OperatorType.EVENTS].entries()) {
        const vendor = await Vendor.create({ email: `weekend${index}@example.com`, password: 'secret1', businessName: `Weekend ${index}`, operatorType, serviceCategories: ['photography'], isSuperAdmin: index === 2, apps: { tickets: { enabled: true } } });
        tokens.push(signVendorToken(String(vendor._id), { authVersion: vendor.authVersion }));
      }
      for (const token of tokens) {
        await TicketsAuthService.verifyAndResolveSession(token);
        for (const endpoint of ['/feed', '/feed/all', `/users/${buyer.username}/plans`]) {
          const ids: string[] = [];
          let cursor: string | null = null;
          do {
            const res: Response = await request(app).get(`/api/social/weekend${endpoint}`)
              .query(endpoint === '/feed/all' ? { limit: 2, ...(cursor ? { cursor } : {}) } : {})
              .set('Authorization', `Bearer ${token}`).expect(200);
            ids.push(...res.body.data.cards.map((card: any) => card.id));
            cursor = res.body.data.nextCursor ?? null;
          } while (cursor);
          const expected = endpoint.startsWith('/users/') ? [plan] : plans;
          expect(ids).toEqual(expect.arrayContaining(expected.map((p) => p.id)));
          expect(new Set(ids).size).toBe(ids.length);
        }
      }
      await request(app).post('/api/social/weekend/plans').set('Authorization', `Bearer ${buyerToken}`).send({ statusType: 'have_plans', media: [] }).expect(400);
    } finally {
      if (previousBase === undefined) delete process.env['UPDATES_R2_PUBLIC_URL'];
      else process.env['UPDATES_R2_PUBLIC_URL'] = previousBase;
    }
  });

  it.each([OperatorType.EVENTS, OperatorType.BOTH, OperatorType.SERVICES])('lets %s owners upload images/videos and manage only their own weekend posts', async operatorType => {
    const vendor = await Vendor.create({ businessName: 'Weekend brand', password: 'secret1', operatorType, serviceCategories: ['photography'],
      logoUrl: 'https://cdn.carrottickets.com/logo.jpg', apps: { tickets: { enabled: true } } });
    const token = await signVendorSessionToken(String(vendor._id));
    const auth = { Authorization: `Bearer ${token}` };
    const oldBase = process.env['UPDATES_R2_PUBLIC_URL'];
    process.env['UPDATES_R2_PUBLIC_URL'] = 'https://cdn.carrottickets.com';
    const upload = jest.spyOn(updatesR2, 'presignPut').mockResolvedValue('https://upload.test/signed');
    try {
      const identity = await request(app).get('/api/social/weekend/participant').set(auth).expect(200);
      expect(identity.body.data).toMatchObject({ name: vendor.businessName, avatarUrl: vendor.logoUrl });
      expect(await Buyer.findById(identity.body.data.id)).toMatchObject({ sourceVendorId: vendor._id });
      for (const [contentType, type] of [['image/jpeg', 'image'], ['video/mp4', 'video']]) {
        await request(app).post('/api/social/weekend/plans/media').set(auth).send({ contentType }).expect(200)
          .expect(r => expect(r.body.data).toMatchObject({ uploadUrl: 'https://upload.test/signed', type }));
      }
      const input = { statusType: 'have_plans', media: [{ url: 'https://cdn.carrottickets.com/plan.mp4', type: 'video' }] };
      const created = await request(app).post('/api/social/weekend/plans').set(auth).send(input).expect(201);
      const id = created.body.data.plan.id;
      await request(app).get('/api/social/weekend/feed/all').set(auth).expect(200)
        .expect(r => expect(r.body.data.cards).toEqual(expect.arrayContaining([expect.objectContaining({ id, isOwner: true, editableAsPlan: true })])));
      const buyer = await seedBuyer();
      const buyerToken = await signBuyerSessionToken(buyer.phone!);
      await request(app).put(`/api/social/weekend/plans/${id}`).set('Authorization', `Bearer ${buyerToken}`).send(input).expect(404);
      await request(app).get(`/api/social/weekend/plans/${id}`).set(auth).expect(200);
      await request(app).put(`/api/social/weekend/plans/${id}`).set(auth).send({ ...input, message: 'Updated' }).expect(200);
      await request(app).delete(`/api/social/weekend/plans/${id}`).set(auth).expect(200);
      // A brand session must never acquire buyer-only account privileges.
      await request(app).get('/api/social/me').set(auth).expect(401);
      const staff = await signStaffSessionToken(String(vendor._id), [TicketsPermission.EDIT_BRAND]);
      await request(app).post('/api/social/weekend/plans').set('Authorization', `Bearer ${staff}`).send(input).expect(403);
      await Vendor.updateOne({ _id: vendor._id }, { $unset: { logoUrl: 1 } });
      await request(app).post('/api/social/weekend/plans/media').set(auth).send({ contentType: 'image/jpeg' }).expect(403);
      await Vendor.updateOne({ _id: vendor._id }, { $set: { isActive: false } });
      await request(app).delete(`/api/social/weekend/plans/${id}`).set(auth).expect(401);
    } finally {
      upload.mockRestore();
      if (oldBase === undefined) delete process.env['UPDATES_R2_PUBLIC_URL'];
      else process.env['UPDATES_R2_PUBLIC_URL'] = oldBase;
    }
  });

  it('persists weekend views, likes and comment threads on the selected card', async () => {
    const buyer = await seedBuyer();
    const plan = await WeekendService.upsertStatus(buyer, { statusType: 'have_plans' });
    const token = await signBuyerSessionToken(PHONE);
    const base = `/api/social/weekend/cards/${plan.id}`;
    await request(app).post(`${base}/view`).expect(200).expect(r => expect(r.body.data.viewCount).toBe(1));
    await request(app).post(`${base}/like`).expect(401);
    await request(app).post(`${base}/like`).set('Authorization', `Bearer ${token}`).expect(200)
      .expect(r => expect(r.body.data).toMatchObject({ active: true, likeCount: 1 }));
    const created = await request(app).post(`${base}/comments`).set('Authorization', `Bearer ${token}`).send({ body: 'See you there!' }).expect(201);
    const commentId = created.body.data.id;
    await request(app).post(`${base}/comments`).set('Authorization', `Bearer ${token}`).send({ body: 'Bringing friends', parentId: commentId }).expect(201);
    await request(app).get(`${base}/comments`).expect(200).expect(r => {
      expect(r.body.data.comments[0]).toMatchObject({ body: 'See you there!', replies: [expect.objectContaining({ body: 'Bringing friends' })] });
    });
    await request(app).get(base).set('Authorization', `Bearer ${token}`).expect(200)
      .expect(r => expect(r.body.data.card).toMatchObject({ viewCount: 1, likeCount: 1, liked: true, commentCount: 2 }));
    await request(app).post(`${base}/like`).set('Authorization', `Bearer ${token}`).expect(200)
      .expect(r => expect(r.body.data).toMatchObject({ active: false, likeCount: 0 }));
    await request(app).delete(`/api/social/weekend/comments/${commentId}`).set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).get(`${base}/comments`).expect(200).expect(r => expect(r.body.data.comments).toEqual([]));
    await request(app).get(base).expect(200).expect(r => expect(r.body.data.card.commentCount).toBe(0));
  });

  it('rejects engagement and shared links when the viewer cannot see a plan', async () => {
    const owner = await seedBuyer();
    const plan = await WeekendService.upsertStatus(owner, { statusType: 'have_plans', audience: 'only_me' });
    const viewer = await seedBuyer('+26878422614', 'private_viewer');
    const token = await signBuyerSessionToken(viewer.phone!);
    const base = `/api/social/weekend/cards/${plan.id}`;
    await request(app).get(base).expect(404);
    await request(app).get(`${base}/comments`).expect(404);
    for (const action of ['view', 'like', 'comments']) {
      await request(app).post(`${base}/${action}`).set('Authorization', `Bearer ${token}`).send({ body: 'Hidden' }).expect(404);
    }
  });

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
      const auth = `Bearer ${await signBuyerSessionToken(PHONE)}`;

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
        const auth = `Bearer ${await signBuyerSessionToken(PHONE)}`;

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
      const auth = `Bearer ${await signBuyerSessionToken(PHONE)}`;

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
