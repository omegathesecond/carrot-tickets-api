import { seedVendorSessionToken, signAdminSessionToken } from '@/__tests__/helpers/auth';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerSessionToken } from '@/__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { VendorSubUser } from '@models/vendorSubUser.model';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import { SubUserRole } from '@interfaces/subUser.interface';
import { TicketsRole } from '@interfaces/ticketsPermission.interface';

jest.mock('@services/push.service', () => ({ PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) } }));

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR_ID = '64c000000000000000000a01';
const BUYER_PHONE = '+26878422613';

async function vendorToken(vendorId = VENDOR_ID, permissions = ['tickets:edit_event', 'tickets:view_stats', 'tickets:manage_access', 'tickets:export_reports']) {
  return await seedVendorSessionToken(vendorId, { permissions: permissions });
}

async function makeEvent(vendorId = VENDOR_ID) {
  const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId),
    name: 'Route Test Event',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 3 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 50, sold: 0, reserved: 0 }],
  });
}

async function makeBuyer(phone: string) {
  return Buyer.create({ phone, password: 'secret123', name: 'Route Buyer', dmPrivacy: 'community', notificationPrefs: { announcements: true, dms: true, mentions: true, social: true, reminders: true } });
}

describe('Share&Earn routes', () => {
  beforeAll(connectTestDb);
  beforeEach(async () => {
    await Vendor.create([
      { _id: VENDOR_ID, email: 'organizer@example.com', password: 'secret123', businessName: 'Organizer' },
      { _id: '64c000000000000000000b02', email: 'rival@example.com', password: 'secret123', businessName: 'Rival' },
    ]);
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('organizer configures, previews and activates a campaign; the event page then exposes it', async () => {
    const event = await makeEvent();

    const draft = await request(app)
      .put(`/api/tickets/events/${event._id}/share-earn/campaign`)
      .set('Authorization', `Bearer ${await vendorToken()}`)
      .send({
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 10 }],
        showLeaderboard: true,
      })
      .expect(200);
    expect(draft.body.data.campaign.status).toBe('draft');

    const activated = await request(app)
      .post(`/api/tickets/events/${event._id}/share-earn/campaign/activate`)
      .set('Authorization', `Bearer ${await vendorToken()}`)
      .expect(200);
    expect(activated.body.data.campaign.status).toBe('active');

    const publicView = await request(app).get(`/api/public/events/${event._id}/share-earn`).expect(200);
    expect(publicView.body.data.campaign.status).toBe('active');
    expect(publicView.body.data.joined).toBeNull();
  });

  it('rejects a rival vendor from configuring another organizer\'s event', async () => {
    const event = await makeEvent();
    await request(app)
      .put(`/api/tickets/events/${event._id}/share-earn/campaign`)
      .set('Authorization', `Bearer ${await vendorToken('64c000000000000000000b02')}`)
      .send({
        startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
        rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 5 }],
      })
      .expect(403);
  });

  it('requires sign-in to join, and returns the buyer to the same event afterward with no duplicate registration', async () => {
    const event = await makeEvent();
    await request(app)
      .put(`/api/tickets/events/${event._id}/share-earn/campaign`)
      .set('Authorization', `Bearer ${await vendorToken()}`)
      .send({
        startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
        rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 10 }],
      })
      .expect(200);
    await request(app).post(`/api/tickets/events/${event._id}/share-earn/campaign/activate`).set('Authorization', `Bearer ${await vendorToken()}`).expect(200);

    await request(app).post(`/api/public/events/${event._id}/share-earn/join`).expect(401);

    await makeBuyer(BUYER_PHONE);
    const joined = await request(app)
      .post(`/api/public/events/${event._id}/share-earn/join`)
      .set('Authorization', `Bearer ${await signBuyerSessionToken(BUYER_PHONE)}`)
      .expect(201);
    expect(joined.body.data.referralCode).toBeTruthy();

    const again = await request(app)
      .post(`/api/public/events/${event._id}/share-earn/join`)
      .set('Authorization', `Bearer ${await signBuyerSessionToken(BUYER_PHONE)}`)
      .expect(201);
    expect(again.body.data.referralCode).toBe(joined.body.data.referralCode);

    // Now visible to the authenticated viewer on the event page.
    const view = await request(app)
      .get(`/api/public/events/${event._id}/share-earn`)
      .set('Authorization', `Bearer ${await signBuyerSessionToken(BUYER_PHONE)}`)
      .expect(200);
    expect(view.body.data.joined.referralCode).toBe(joined.body.data.referralCode);
  });

  it('a public click on a referral link resolves the event even while logged out', async () => {
    const event = await makeEvent();
    await request(app)
      .put(`/api/tickets/events/${event._id}/share-earn/campaign`)
      .set('Authorization', `Bearer ${await vendorToken()}`)
      .send({
        startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
        rewardRules: [{ trigger: 'per_sale', rewardType: 'points', provider: 'carrot', pointsAmount: 10 }],
      })
      .expect(200);
    await request(app).post(`/api/tickets/events/${event._id}/share-earn/campaign/activate`).set('Authorization', `Bearer ${await vendorToken()}`).expect(200);
    await makeBuyer(BUYER_PHONE);
    const joined = await request(app)
      .post(`/api/public/events/${event._id}/share-earn/join`)
      .set('Authorization', `Bearer ${await signBuyerSessionToken(BUYER_PHONE)}`)
      .expect(201);

    const resolved = await request(app).get(`/api/public/share-earn/resolve/${joined.body.data.referralCode}`).expect(200);
    expect(resolved.body.data.eventMongoId).toBe(String(event._id));

    const click = await request(app)
      .post('/api/public/share-earn/track-click')
      .send({ referralCode: joined.body.data.referralCode, visitorKey: 'anon-visitor-1' })
      .expect(200);
    expect(click.body.data.eventMongoId).toBe(String(event._id));
  });

  it('the organizer dashboard requires the vendor auth VIEW_STATS gate', async () => {
    const event = await makeEvent();
    await request(app).get(`/api/tickets/events/${event._id}/share-earn/dashboard`).expect(401);
    await request(app)
      .get(`/api/tickets/events/${event._id}/share-earn/dashboard`)
      .set('Authorization', `Bearer ${await vendorToken(VENDOR_ID, [])}`)
      .expect(403);
    await request(app)
      .get(`/api/tickets/events/${event._id}/share-earn/dashboard`)
      .set('Authorization', `Bearer ${await vendorToken()}`)
      .expect(404); // no campaign set up yet
  });
});
