import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Membership } from '@models/membership.model';
import { Channel } from '@models/channel.model';
import { CommunityService } from '@services/community.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { resetBuckets } from '@utils/rateLimit.util';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const PHONE = '+26878422613';

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
  const announcements = await Channel.findOne({ communityId: community._id, slug: 'announcements' });
  const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', username: 'listener_one' });
  await Membership.create({ buyerId: buyer._id, communityId: community._id });
  return { vendor, seeded, community, announcements: announcements!, buyerAuth: `Bearer ${signBuyerToken(PHONE)}` };
}

describe('organizer announcements', () => {
  beforeAll(connectTestDb);
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('owner vendor posts; buyers read it with organizer branding', async () => {
    const { vendor, seeded, announcements, buyerAuth } = await seedWorld();

    const posted = await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/announcements`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
      .send({ body: 'Gates open 18:00 — bring ID!' })
      .expect(201);
    expect(posted.body.data.senderType).toBe('organizer');
    expect(posted.body.data.sender.name).toBe('Piano Republic Events');
    expect(posted.body.data.sender.avatarUrl).toBe('https://cdn.example.com/logo.png');
    expect(posted.body.data.sender.username).toBeNull();

    const list = await request(app)
      .get(`/api/community/channels/${String(announcements._id)}/messages`)
      .set('Authorization', buyerAuth)
      .expect(200);
    expect(list.body.data[0].body).toBe('Gates open 18:00 — bring ID!');
    expect(list.body.data[0].senderType).toBe('organizer');
    expect(list.body.data[0].sender.name).toBe('Piano Republic Events');
  });

  it('authz: non-owner vendor 403, missing permission 403, buyer POST still rejected, unknown event 404', async () => {
    const { seeded, announcements, buyerAuth } = await seedWorld();

    const other = await Vendor.create({
      businessName: 'Rival Events', email: 'rival@example.com', password: 'secret123', phoneNumber: '+26878000097',
    });
    await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/announcements`)
      .set('Authorization', `Bearer ${signVendorToken(String(other._id))}`)
      .send({ body: 'hijack' })
      .expect(403);

    const { vendor } = await (async () => ({ vendor: await Vendor.findOne({ businessName: 'Piano Republic Events' }) }))();
    await request(app)
      .post(`/api/tickets/events/${seeded.eventId}/announcements`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendor!._id), [])}`)
      .send({ body: 'no perms' })
      .expect(403);

    // buyers still cannot post into the organizer-only channel
    await request(app)
      .post(`/api/community/channels/${String(announcements._id)}/messages`)
      .set('Authorization', buyerAuth)
      .send({ body: 'sneaky buyer' })
      .expect(403);

    await request(app)
      .post(`/api/tickets/events/aaaaaaaaaaaaaaaaaaaaaaaa/announcements`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendor!._id))}`)
      .send({ body: 'ghost' })
      .expect(404);
  });

  it('validation 400 + vendor rate limit 429', async () => {
    const { vendor, seeded } = await seedWorld();
    const auth = `Bearer ${signVendorToken(String(vendor._id))}`;

    await request(app).post(`/api/tickets/events/${seeded.eventId}/announcements`)
      .set('Authorization', auth).send({ body: '' }).expect(400);

    resetBuckets();
    for (let i = 0; i < 5; i++) {
      await request(app).post(`/api/tickets/events/${seeded.eventId}/announcements`)
        .set('Authorization', auth).send({ body: `update ${i}` }).expect(201);
    }
    await request(app).post(`/api/tickets/events/${seeded.eventId}/announcements`)
      .set('Authorization', auth).send({ body: 'too fast' }).expect(429);
  });
});
