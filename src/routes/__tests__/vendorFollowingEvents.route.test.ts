import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Follow } from '@models/follow.model';

const BUYER_PHONE = '+26878422613';

async function makeEvent(overrides: Record<string, any> = {}) {
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Event',
    venue: 'V',
    eventDate: new Date(),
    startTime: new Date(),
    endTime: new Date(),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }],
    ...overrides,
  });
}

/**
 * The "Following" tab of the organizer Home feed. Vendor twin of the buyer
 * suite in consumerCalendar.route.test.ts — the interesting part is that Follow
 * rows are matched on followerType 'vendor', so a brand sees ITS follows, never
 * a buyer's.
 */
describe('GET /api/tickets/social/me/following/events', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns upcoming published events from organizers the BRAND follows, soonest first', async () => {
    const brandId = new mongoose.Types.ObjectId();
    const followedVendor = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'vendor', followerId: brandId, targetType: 'organizer', targetId: followedVendor });

    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const later = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await makeEvent({ name: 'Later Show', vendorId: followedVendor, eventDate: later, endTime: later, status: EventStatus.PUBLISHED });
    await makeEvent({ name: 'Soon Show', vendorId: followedVendor, eventDate: soon, endTime: soon, status: EventStatus.PUBLISHED });

    const res = await request(app)
      .get('/api/tickets/social/me/following/events')
      .set('Authorization', `Bearer ${signVendorToken(String(brandId))}`)
      .expect(200);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Soon Show', 'Later Show']);
  });

  it('excludes unfollowed organizers, drafts, and finished events', async () => {
    const brandId = new mongoose.Types.ObjectId();
    const followedVendor = new mongoose.Types.ObjectId();
    const otherVendor = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'vendor', followerId: brandId, targetType: 'organizer', targetId: followedVendor });

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await makeEvent({ name: 'Unfollowed Org', vendorId: otherVendor, eventDate: future, endTime: future, status: EventStatus.PUBLISHED });
    await makeEvent({ name: 'Draft Future', vendorId: followedVendor, eventDate: future, endTime: future, status: EventStatus.DRAFT });
    await makeEvent({ name: 'Published Past', vendorId: followedVendor, eventDate: past, endTime: past, status: EventStatus.PUBLISHED });
    await makeEvent({ name: 'Published Future', vendorId: followedVendor, eventDate: future, endTime: future, status: EventStatus.PUBLISHED });

    const res = await request(app)
      .get('/api/tickets/social/me/following/events')
      .set('Authorization', `Bearer ${signVendorToken(String(brandId))}`)
      .expect(200);
    expect(res.body.data.events.map((c: any) => c.name)).toEqual(['Published Future']);
  });

  // followerType is the whole point of the vendor twin: a Follow row created by
  // a BUYER whose id collides with the brand's must not leak into the brand's
  // Following tab.
  it("ignores a buyer's follow row that shares the brand's id", async () => {
    const sharedId = new mongoose.Types.ObjectId();
    const followedVendor = new mongoose.Types.ObjectId();
    await Follow.create({ followerType: 'buyer', followerId: sharedId, targetType: 'organizer', targetId: followedVendor });

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await makeEvent({ name: 'Buyer Follows This', vendorId: followedVendor, eventDate: future, endTime: future, status: EventStatus.PUBLISHED });

    const res = await request(app)
      .get('/api/tickets/social/me/following/events')
      .set('Authorization', `Bearer ${signVendorToken(String(sharedId))}`)
      .expect(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('returns an empty list when the brand follows no organizers', async () => {
    const res = await request(app)
      .get('/api/tickets/social/me/following/events')
      .set('Authorization', `Bearer ${signVendorToken(String(new mongoose.Types.ObjectId()))}`)
      .expect(200);
    expect(res.body.data.events).toEqual([]);
  });

  it('401s a buyer token and an anonymous request', async () => {
    await Buyer.create({ phone: BUYER_PHONE, password: 'secret1', name: 'Buyer' });
    await request(app)
      .get('/api/tickets/social/me/following/events')
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .expect(401);
    await request(app).get('/api/tickets/social/me/following/events').expect(401);
  });
});
