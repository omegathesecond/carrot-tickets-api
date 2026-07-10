import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Channel } from '@models/channel.model';
import { CommunityService } from '@services/community.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Report } from '@models/report.model';
import { resetBuckets } from '@utils/rateLimit.util';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

function signVendorToken(vendorId: string, permissions: string[] = [], isSuperAdmin = false): string {
  return jwt.sign(
    { app: 'tickets', vendorId, userType: 'vendor', isSuperAdmin, role: 'owner', permissions },
    JWT_SECRET
  );
}

const PHONE = '+26878422613';

async function seedWorld() {
  const vendor = await Vendor.create({
    businessName: 'Piano Republic Events', email: 'org@example.com', password: 'secret123',
    phoneNumber: '+26878000099',
  });
  const seeded = await seedPublishedEvent({ vendorId: vendor._id as any });
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, String(vendor._id));
  const general = (await Channel.findOne({ communityId: community._id, slug: 'general' }))!;

  const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Reporter Buyer' });
  const buyerAuth = `Bearer ${signBuyerToken(PHONE)}`;
  const adminAuth = `Bearer ${signVendorToken('admin-1', [TicketsPermission.MODERATE_SOCIAL])}`;
  const superAdminAuth = `Bearer ${signVendorToken('super-1', [], true)}`;

  await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', buyerAuth).expect(200);

  return { vendor, seeded, community, general, buyer, buyerAuth, adminAuth, superAdminAuth };
}

/** File a report and hand back the admin queue row for it (adminAuth must hold MODERATE_SOCIAL). */
async function fileAndFetch(
  reporterAuth: string,
  adminAuth: string,
  body: Record<string, unknown>
): Promise<any> {
  await request(app).post('/api/community/reports').set('Authorization', reporterAuth).send(body).expect(201);
  const list = await request(app).get('/api/tickets/reports').set('Authorization', adminAuth).expect(200);
  return list.body.data[0];
}

describe('report routes', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Report.init();
  });
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('POST /api/community/reports', () => {
    it('files a message report — 201 on first file, 200 on a duplicate open report', async () => {
      const { general, buyerAuth } = await seedWorld();
      const reporterAuth = `Bearer ${signBuyerToken('+26878300001')}`;
      await Buyer.create({ phone: '+26878300001', password: 'secret1', name: 'Rando' });

      const sent = await request(app)
        .post(`/api/community/channels/${String(general._id)}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'spam link' })
        .expect(201);

      const first = await request(app)
        .post('/api/community/reports')
        .set('Authorization', reporterAuth)
        .send({ targetType: 'message', messageId: sent.body.data.id, reason: 'looks like spam' })
        .expect(201);
      expect(first.body.data).toEqual({ reported: true });

      const second = await request(app)
        .post('/api/community/reports')
        .set('Authorization', reporterAuth)
        .send({ targetType: 'message', messageId: sent.body.data.id, reason: 'still spam' })
        .expect(200);
      expect(second.body.data).toEqual({ reported: true });
    });

    it('files a buyer report', async () => {
      const { buyerAuth } = await seedWorld();
      const target = await Buyer.create({ phone: '+26878300002', password: 'secret1', name: 'Target' });

      await request(app)
        .post('/api/community/reports')
        .set('Authorization', buyerAuth)
        .send({ targetType: 'buyer', targetBuyerId: String(target._id), reason: 'harassment' })
        .expect(201);
    });

    it('rejects a body with both messageId and targetBuyerId, and a body with neither (400)', async () => {
      const { buyerAuth } = await seedWorld();
      const target = await Buyer.create({ phone: '+26878300003', password: 'secret1' });
      await request(app)
        .post('/api/community/reports')
        .set('Authorization', buyerAuth)
        .send({
          targetType: 'buyer',
          targetBuyerId: String(target._id),
          messageId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          reason: 'x',
        })
        .expect(400);
      await request(app)
        .post('/api/community/reports')
        .set('Authorization', buyerAuth)
        .send({ targetType: 'buyer', reason: 'x' })
        .expect(400);
    });

    it('401s without a buyer token', async () => {
      await request(app)
        .post('/api/community/reports')
        .send({ targetType: 'buyer', targetBuyerId: 'aaaaaaaaaaaaaaaaaaaaaaaa', reason: 'x' })
        .expect(401);
    });
  });

  describe('admin queue — GET/POST /api/tickets/reports*', () => {
    it('403s a team member without tickets:moderate_social; 200s one who holds it', async () => {
      const { buyerAuth, adminAuth } = await seedWorld();
      const target = await Buyer.create({ phone: '+26878300010', password: 'secret1' });
      await request(app)
        .post('/api/community/reports')
        .set('Authorization', buyerAuth)
        .send({ targetType: 'buyer', targetBuyerId: String(target._id), reason: 'x' })
        .expect(201);

      const noPerm = `Bearer ${signVendorToken('vendor-no-perm', [TicketsPermission.EDIT_EVENT])}`;
      await request(app).get('/api/tickets/reports').set('Authorization', noPerm).expect(403);

      const list = await request(app).get('/api/tickets/reports').set('Authorization', adminAuth).expect(200);
      expect(list.body.data).toHaveLength(1);
    });

    it('a super-admin token (no explicit permission) can also read the queue', async () => {
      const { superAdminAuth } = await seedWorld();
      await request(app).get('/api/tickets/reports').set('Authorization', superAdminAuth).expect(200);
    });

    it('defaults to status=open and supports the status filter', async () => {
      const { buyerAuth, adminAuth } = await seedWorld();
      const target = await Buyer.create({ phone: '+26878300011', password: 'secret1' });
      const row = await fileAndFetch(buyerAuth, adminAuth, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });

      await request(app)
        .post(`/api/tickets/reports/${row.id}/resolve`)
        .set('Authorization', adminAuth)
        .send({ action: 'dismiss' })
        .expect(200);

      const stillOpen = await request(app).get('/api/tickets/reports').set('Authorization', adminAuth).expect(200);
      expect(stillOpen.body.data).toHaveLength(0);
      const dismissed = await request(app)
        .get('/api/tickets/reports?status=dismissed')
        .set('Authorization', adminAuth)
        .expect(200);
      expect(dismissed.body.data).toHaveLength(1);
      expect(dismissed.body.data[0].id).toBe(row.id);
    });

    it('resolve: delete_message deletes a channel message cross-vendor and the admin view shows it deleted+unmasked', async () => {
      const { general, buyerAuth } = await seedWorld();
      const reporterAuth = `Bearer ${signBuyerToken('+26878300012')}`;
      await Buyer.create({ phone: '+26878300012', password: 'secret1' });

      const sent = await request(app)
        .post(`/api/community/channels/${String(general._id)}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'evidence text' })
        .expect(201);

      // Reviewed by a DIFFERENT vendor's admin token — proves no ownership walk applies to admins.
      const rival = await Vendor.create({
        businessName: 'Rival Events', email: 'rival-report@example.com', password: 'secret123', phoneNumber: '+26878000098',
      });
      const rivalAdminAuth = `Bearer ${signVendorToken(String(rival._id), [TicketsPermission.MODERATE_SOCIAL])}`;

      const row = await fileAndFetch(reporterAuth, rivalAdminAuth, {
        targetType: 'message',
        messageId: sent.body.data.id,
        reason: 'evidence',
      });

      const resolved = await request(app)
        .post(`/api/tickets/reports/${row.id}/resolve`)
        .set('Authorization', rivalAdminAuth)
        .send({ action: 'delete_message' })
        .expect(200);

      expect(resolved.body.data.status).toBe('resolved');
      expect(resolved.body.data.message.deleted).toBe(true);
      expect(resolved.body.data.message.body).toBe('evidence text'); // unmasked despite deletion

      const readBack = await request(app)
        .get(`/api/community/channels/${String(general._id)}/messages`)
        .set('Authorization', buyerAuth)
        .expect(200);
      const buyerFacingRow = readBack.body.data.find((m: any) => m.id === sent.body.data.id);
      expect(buyerFacingRow.deleted).toBe(true);
      expect(buyerFacingRow.body).toBe(''); // buyer-facing read stays masked — toView untouched
    });

    it('resolve: suspend_buyer then unsuspend_buyer round-trips socialSuspendedAt, enforced end-to-end on a write path', async () => {
      const { buyerAuth, adminAuth } = await seedWorld();
      const target = await Buyer.create({ phone: '+26878300013', password: 'secret1', name: 'Follow Target' });
      const targetAuth = `Bearer ${signBuyerToken('+26878300013')}`;
      const someoneElse = await Buyer.create({ phone: '+26878300014', password: 'secret1' });

      const row = await fileAndFetch(buyerAuth, adminAuth, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'harassment',
      });

      const resolved = await request(app)
        .post(`/api/tickets/reports/${row.id}/resolve`)
        .set('Authorization', adminAuth)
        .send({ action: 'suspend_buyer', note: 'confirmed harassment' })
        .expect(200);
      expect(resolved.body.data.status).toBe('resolved');
      expect(resolved.body.data.resolutionNote).toBe('confirmed harassment');

      // End-to-end enforcement: the suspended buyer can no longer follow someone.
      await request(app)
        .post('/api/social/follow')
        .set('Authorization', targetAuth)
        .send({ targetType: 'buyer', targetId: String(someoneElse._id) })
        .expect(403)
        .expect((res) => {
          expect(res.body.message).toBe('Your community access is suspended');
        });

      // Unsuspend via a fresh report on the same buyer, then the follow succeeds.
      const row2 = await fileAndFetch(buyerAuth, adminAuth, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'appeal',
      });
      await request(app)
        .post(`/api/tickets/reports/${row2.id}/resolve`)
        .set('Authorization', adminAuth)
        .send({ action: 'unsuspend_buyer' })
        .expect(200);

      await request(app)
        .post('/api/social/follow')
        .set('Authorization', targetAuth)
        .send({ targetType: 'buyer', targetId: String(someoneElse._id) })
        .expect(200);
    });

    it('resolve: dismiss just closes the report, no side effects', async () => {
      const { buyerAuth, adminAuth } = await seedWorld();
      const target = await Buyer.create({ phone: '+26878300015', password: 'secret1' });
      const row = await fileAndFetch(buyerAuth, adminAuth, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });

      const resolved = await request(app)
        .post(`/api/tickets/reports/${row.id}/resolve`)
        .set('Authorization', adminAuth)
        .send({ action: 'dismiss' })
        .expect(200);
      expect(resolved.body.data.status).toBe('dismissed');

      const reloaded = await Buyer.findById(target._id);
      expect(reloaded!.socialSuspendedAt).toBeFalsy();
    });

    it('404s an unknown report id, 400s a malformed one, 409s an already-resolved one', async () => {
      const { buyerAuth, adminAuth } = await seedWorld();
      await request(app)
        .post('/api/tickets/reports/aaaaaaaaaaaaaaaaaaaaaaaa/resolve')
        .set('Authorization', adminAuth)
        .send({ action: 'dismiss' })
        .expect(404);
      await request(app)
        .post('/api/tickets/reports/not-an-id/resolve')
        .set('Authorization', adminAuth)
        .send({ action: 'dismiss' })
        .expect(400);

      const target = await Buyer.create({ phone: '+26878300016', password: 'secret1' });
      const row = await fileAndFetch(buyerAuth, adminAuth, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });
      await request(app).post(`/api/tickets/reports/${row.id}/resolve`).set('Authorization', adminAuth).send({ action: 'dismiss' }).expect(200);
      await request(app).post(`/api/tickets/reports/${row.id}/resolve`).set('Authorization', adminAuth).send({ action: 'dismiss' }).expect(409);
    });

    it('resolve rejects an unknown action (400 at the Joi layer)', async () => {
      const { buyerAuth, adminAuth } = await seedWorld();
      const target = await Buyer.create({ phone: '+26878300017', password: 'secret1' });
      const row = await fileAndFetch(buyerAuth, adminAuth, {
        targetType: 'buyer',
        targetBuyerId: String(target._id),
        reason: 'x',
      });
      await request(app)
        .post(`/api/tickets/reports/${row.id}/resolve`)
        .set('Authorization', adminAuth)
        .send({ action: 'nuke_from_orbit' })
        .expect(400);
    });
  });
});
