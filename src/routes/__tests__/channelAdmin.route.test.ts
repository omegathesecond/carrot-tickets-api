import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Vendor } from '@models/vendor.model';
import { Channel } from '@models/channel.model';
import { CommunityService } from '@services/community.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

function signVendorToken(vendorId: string, permissions: string[] = [TicketsPermission.EDIT_EVENT]): string {
  return jwt.sign(
    { app: 'tickets', vendorId, userType: 'vendor', isSuperAdmin: false, role: 'owner', permissions },
    JWT_SECRET
  );
}

async function seedWorld() {
  const vendor = await Vendor.create({
    businessName: 'Piano Republic Events', email: 'org@example.com', password: 'secret123',
    phoneNumber: '+26878000099', logoUrl: 'https://cdn.example.com/logo.png',
  });
  const seeded = await seedPublishedEvent({ vendorId: vendor._id as any });
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, String(vendor._id));
  const general = await Channel.findOne({ communityId: community._id, slug: 'general' });
  return { vendor, seeded, community, general: general! };
}

describe('organizer channel management routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lists all channels including archived, keyed with communityId', async () => {
    const { vendor, seeded, community, general } = await seedWorld();
    general.archived = true;
    await general.save();

    const res = await request(app)
      .get(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
      .expect(200);

    expect(res.body.data.communityId).toBe(String(community._id));
    expect(res.body.data.channels).toHaveLength(3);
    const bySlug = Object.fromEntries(res.body.data.channels.map((c: any) => [c.slug, c]));
    expect(bySlug['general'].archived).toBe(true);
    expect(bySlug['announcements'].isDefault).toBe(true);
  });

  it('creates a channel and rejects a duplicate slug with 409', async () => {
    const { vendor, seeded } = await seedWorld();
    const auth = `Bearer ${signVendorToken(String(vendor._id))}`;

    const created = await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', auth)
      .send({ name: 'VIP Lounge', gated: true, postPolicy: 'organizer' })
      .expect(201);
    expect(created.body.data.slug).toBe('vip-lounge');
    expect(created.body.data.gated).toBe(true);
    expect(created.body.data.postPolicy).toBe('organizer');

    await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', auth)
      .send({ name: 'General' })
      .expect(409);
  });

  it('validation 400 for a missing/oversized name', async () => {
    const { vendor, seeded } = await seedWorld();
    const auth = `Bearer ${signVendorToken(String(vendor._id))}`;

    await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', auth)
      .send({ name: '' })
      .expect(400);
    await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', auth)
      .send({ name: 'x'.repeat(41) })
      .expect(400);
  });

  it('patches a non-default channel (rename + gated + archived)', async () => {
    const { vendor, seeded } = await seedWorld();
    const auth = `Bearer ${signVendorToken(String(vendor._id))}`;

    const created = await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', auth)
      .send({ name: 'VIP Lounge' })
      .expect(201);

    const patched = await request(app)
      .patch(`/api/tickets/channels/${created.body.data.id}`)
      .set('Authorization', auth)
      .send({ name: 'VVIP Lounge', gated: true })
      .expect(200);
    expect(patched.body.data.name).toBe('VVIP Lounge');
    expect(patched.body.data.slug).toBe('vvip-lounge');
    expect(patched.body.data.gated).toBe(true);

    await request(app)
      .patch(`/api/tickets/channels/${created.body.data.id}`)
      .set('Authorization', auth)
      .send({ archived: true })
      .expect(200);
  });

  it('rejects renaming/archiving a default channel with 400', async () => {
    const { vendor, general } = await seedWorld();
    const auth = `Bearer ${signVendorToken(String(vendor._id))}`;

    await request(app)
      .patch(`/api/tickets/channels/${String(general._id)}`)
      .set('Authorization', auth)
      .send({ name: 'Renamed General' })
      .expect(400);
    await request(app)
      .patch(`/api/tickets/channels/${String(general._id)}`)
      .set('Authorization', auth)
      .send({ archived: true })
      .expect(400);

    // ...but gated/postPolicy toggles are fine
    await request(app)
      .patch(`/api/tickets/channels/${String(general._id)}`)
      .set('Authorization', auth)
      .send({ gated: true })
      .expect(200);
  });

  it('authz: non-owner vendor 403, missing permission 403, unknown event/channel 404', async () => {
    const { vendor, seeded, general } = await seedWorld();

    const other = await Vendor.create({
      businessName: 'Rival Events', email: 'rival@example.com', password: 'secret123', phoneNumber: '+26878000097',
    });
    await request(app)
      .get(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', `Bearer ${signVendorToken(String(other._id))}`)
      .expect(403);
    await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', `Bearer ${signVendorToken(String(other._id))}`)
      .send({ name: 'Hijack' })
      .expect(403);
    await request(app)
      .patch(`/api/tickets/channels/${String(general._id)}`)
      .set('Authorization', `Bearer ${signVendorToken(String(other._id))}`)
      .send({ gated: true })
      .expect(403);

    await request(app)
      .get(`/api/tickets/events/${seeded.eventId}/channels`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id), [])}`)
      .expect(403);

    await request(app)
      .get(`/api/tickets/events/aaaaaaaaaaaaaaaaaaaaaaaa/channels`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
      .expect(404);
    await request(app)
      .patch(`/api/tickets/channels/aaaaaaaaaaaaaaaaaaaaaaaa`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
      .send({ gated: true })
      .expect(404);
  });
});
