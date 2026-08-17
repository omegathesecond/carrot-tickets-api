import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { Update } from '@models/update.model';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

function signVendorToken(vendorId: string, permissions: string[] = [], isSuperAdmin = false): string {
  return jwt.sign(
    { app: 'tickets', vendorId, userType: 'vendor', isSuperAdmin, role: 'owner', permissions },
    JWT_SECRET
  );
}

async function seedReadyUpdate() {
  return Update.create({
    authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption: 'ugly pic',
    media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
  });
}

const inForYou = (body: any, id: string): boolean =>
  (body.data.items || []).some((i: any) => i.id === id);

// Real ObjectId vendor ids: a vendor actor on the for-you feed triggers
// getViewerReactions, which casts the actor id to ObjectId (a non-hex string
// would CastError → 500). A production super-admin always has a real id.
const superId = new mongoose.Types.ObjectId().toString();
const modId = new mongoose.Types.ObjectId().toString();
const superAdmin = () => `Bearer ${signVendorToken(superId, [], true)}`;
const moderator = () => `Bearer ${signVendorToken(modId, [TicketsPermission.MODERATE_SOCIAL])}`;

describe('Discover moderation — /api/tickets/updates/:id/hide-from-discover', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('403s a vendor lacking moderate_social', async () => {
    const u = await seedReadyUpdate();
    const noPerm = `Bearer ${signVendorToken('v', [TicketsPermission.EDIT_EVENT])}`;
    await request(app).post(`/api/tickets/updates/${u.id}/hide-from-discover`).set('Authorization', noPerm).expect(403);
  });

  it('hides a post from the for-you feed, stamps the moderator, then un-hides it (reversible)', async () => {
    const u = await seedReadyUpdate();
    const before = await request(app).get('/api/public/feed?tab=for-you').expect(200);
    expect(inForYou(before.body, u.id)).toBe(true);

    await request(app).post(`/api/tickets/updates/${u.id}/hide-from-discover`).set('Authorization', superAdmin()).expect(200);
    const hidden = await Update.findById(u.id);
    expect(hidden!.hiddenFromDiscoverAt).toBeTruthy();
    expect(hidden!.hiddenFromDiscoverBy).toBe(superId);

    const after = await request(app).get('/api/public/feed?tab=for-you').expect(200);
    expect(inForYou(after.body, u.id)).toBe(false);

    await request(app).delete(`/api/tickets/updates/${u.id}/hide-from-discover`).set('Authorization', moderator()).expect(200);
    const restored = await Update.findById(u.id);
    expect(restored!.hiddenFromDiscoverAt).toBeNull();
    const back = await request(app).get('/api/public/feed?tab=for-you').expect(200);
    expect(inForYou(back.body, u.id)).toBe(true);
  });

  it('404s an unknown id and 400s a malformed one', async () => {
    await request(app)
      .post(`/api/tickets/updates/${new mongoose.Types.ObjectId()}/hide-from-discover`)
      .set('Authorization', superAdmin())
      .expect(404);
    await request(app)
      .post('/api/tickets/updates/not-an-id/hide-from-discover')
      .set('Authorization', superAdmin())
      .expect(400);
  });

  it('marks feed update slides viewerCanModerate for a moderator only', async () => {
    await seedReadyUpdate();
    const anon = await request(app).get('/api/public/feed?tab=for-you').expect(200);
    expect(anon.body.data.items.find((i: any) => i.type === 'update').viewerCanModerate).toBeFalsy();

    const mod = await request(app).get('/api/public/feed?tab=for-you').set('Authorization', superAdmin()).expect(200);
    expect(mod.body.data.items.find((i: any) => i.type === 'update').viewerCanModerate).toBe(true);
  });
});
