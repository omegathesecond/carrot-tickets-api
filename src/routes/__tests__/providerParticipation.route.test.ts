import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { Event } from '@models/event.model';
import { ShareEarnCampaign } from '@models/shareEarnCampaign.model';
import { ShareEarnReward } from '@models/shareEarnReward.model';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { signVendorToken } from '@/__tests__/helpers/auth';

jest.mock('@services/push.service', () => ({ PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) } }));

async function provider(email = 'provider@example.com') {
  const vendor = await Vendor.create({ email, password: 'secret123', businessName: email,
    operatorType: OperatorType.SERVICES, serviceCategories: ['photography'], logoUrl: 'https://example.com/photo.jpg' });
  return { vendor, token: signVendorToken(String(vendor._id), { authVersion: vendor.authVersion }) };
}

describe('Service-provider plans and Share&Earn', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('loads both tabs with a provider session, creates and manages its own plan, and isolates other accounts', async () => {
    const { vendor, token } = await provider();
    const auth = { Authorization: `Bearer ${token}` };
    // A provider must never inherit a buyer identity via a shared contact.
    const buyer = await Buyer.create({ email: vendor.email, password: 'secret123', name: 'Separate buyer' });
    const [, share] = await Promise.all([
      request(app).get('/api/social/plans/mine').set(auth).expect(200),
      request(app).get('/api/public/my-share-earn').set(auth).expect(200),
    ]);
    expect(await Buyer.countDocuments({ sourceVendorId: vendor._id })).toBe(1);
    expect(share.body.success).toBe(true);
    const created = await request(app).post('/api/social/plans').set(auth).send({
      name: 'Provider trip', manualEvent: { name: 'Weekend trip' }, visibility: 'private',
    }).expect(201);
    const planId = created.body.data.id;
    expect(planId).toBeTruthy();
    const detail = await request(app).get(`/api/social/plans/${planId}`).set(auth).expect(200);
    expect(detail.body.data.plan.viewer.isAdmin).toBe(true);
    const mine = await request(app).get('/api/social/plans/mine').set(auth).expect(200);
    expect(mine.body.data.plans.map((plan: { id: string }) => plan.id)).toContain(planId);
    const profile = await Buyer.findOne({ sourceVendorId: vendor._id }).select('+password');
    expect(String(profile!._id)).not.toBe(String(buyer._id));
    expect(profile!.password).toBeUndefined();
    expect(profile!.email).toBeUndefined();
    expect(profile!.name).toBe(vendor.businessName);
    const other = await provider('other@example.com');
    const otherMine = await request(app).get('/api/social/plans/mine').set('Authorization', `Bearer ${other.token}`).expect(200);
    expect(otherMine.body.data.plans).toEqual([]);
    await request(app).patch(`/api/social/plans/${planId}`).set('Authorization', `Bearer ${other.token}`).send({ name: 'Steal' }).expect(403);
    // Buyer-only ticket/profile access remains closed to providers.
    await request(app).get('/api/public/profile').set(auth).expect(401);
    await request(app).post(`/api/public/share-earn/rewards/${buyer._id}/redeem`).set(auth).expect(404);
  });

  it('joins a campaign, loads its own referrals, and redeems only its own rewards', async () => {
    const { token } = await provider();
    const auth = { Authorization: `Bearer ${token}` };
    const owner = new Types.ObjectId();
    const date = new Date(Date.now() + 86400000);
    const event = await Event.create({ vendorId: owner, name: 'Festival', venue: 'Venue',
      eventDate: date, startTime: date, endTime: new Date(date.getTime() + 3600000), ticketTypes: [] });
    const campaign = await ShareEarnCampaign.create({ eventId: event._id, vendorId: owner,
      createdBy: owner, startsAt: new Date(), endsAt: date, status: 'active' });
    const joined = await request(app).post(`/api/public/events/${event._id}/share-earn/join`).set(auth).expect(201);
    expect(joined.body.data.referralCode).toBeTruthy();
    const mine = await request(app).get('/api/public/my-share-earn').set(auth).expect(200);
    expect(mine.body.data.active).toHaveLength(1);
    expect(mine.body.data.active[0].referralCode).toBe(joined.body.data.referralCode);
    const identity = await request(app).get('/api/social/plans/participant').set(auth).expect(200);
    const reward = await ShareEarnReward.create({ campaignId: campaign._id, eventId: event._id,
      promoterId: mine.body.data.active[0].promoterId, buyerId: identity.body.data.id,
      ruleId: 'voucher', trigger: 'milestone', rewardType: 'voucher', provider: 'organizer', status: 'available' });
    const other = await provider('other@example.com');
    await request(app).post(`/api/public/share-earn/rewards/${reward._id}/redeem`)
      .set('Authorization', `Bearer ${other.token}`).expect(404);
    const redeemed = await request(app).post(`/api/public/share-earn/rewards/${reward._id}/redeem`).set(auth).expect(200);
    expect(redeemed.body.data.status).toBe('redeemed');
    const otherMine = await request(app).get('/api/public/my-share-earn').set('Authorization', `Bearer ${other.token}`).expect(200);
    expect(otherMine.body.data.active).toEqual([]);
    expect(otherMine.body.data.rewards).toEqual([]);
  });

  it('keeps normal buyer tab access and rejects expired/revoked provider sessions', async () => {
    const buyer = await Buyer.create({ email: 'buyer@example.com', password: 'secret123' });
    const buyerToken = jwt.sign({ app: 'tickets', userType: 'buyer', buyerId: String(buyer._id), authVersion: buyer.authVersion }, process.env['JWT_SECRET']!);
    for (const path of ['/api/social/plans/mine', '/api/public/my-share-earn']) {
      await request(app).get(path).set('Authorization', `Bearer ${buyerToken}`).expect(200);
    }
    const { vendor, token } = await provider();
    await Vendor.updateOne({ _id: vendor._id }, { $inc: { authVersion: 1 } });
    const expired = signVendorToken(String(vendor._id), { authVersion: vendor.authVersion, exp: 1 });
    for (const path of ['/api/social/plans/mine', '/api/public/my-share-earn']) {
      await request(app).get(path).set('Authorization', `Bearer ${token}`).expect(401);
      await request(app).get(path).set('Authorization', `Bearer ${expired}`).expect(401);
    }
  });

  it('does not grant participation to other vendor verticals', async () => {
    const vendor = await Vendor.create({ email: 'events@example.com', password: 'secret123', businessName: 'Events', operatorType: OperatorType.EVENTS });
    const token = signVendorToken(String(vendor._id), { authVersion: vendor.authVersion });
    for (const path of ['/api/social/plans/mine', '/api/public/my-share-earn']) {
      await request(app).get(path).set('Authorization', `Bearer ${token}`).expect(403);
    }
    expect(await Buyer.countDocuments({ sourceVendorId: vendor._id })).toBe(0);
  });
});
