import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { VerificationStatus } from '@interfaces/vendor.interface';

const soon = (mins: number) => new Date(Date.now() + mins * 60000);

async function makeVendor(businessName: string, extra: Record<string, unknown> = {}) {
  return Vendor.create({
    businessName,
    email: `${businessName.replace(/\W+/g, '').toLowerCase()}@example.com`,
    password: 'secret123',
    isActive: true,
    verificationStatus: VerificationStatus.VERIFIED,
    ...extra,
  });
}

describe('Vendor consumer-reads: /api/tickets/social/{suggestions,recommendations,nearby,me/location}', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Buyer.init(); // builds the buyer 2dsphere index the nearby test relies on
    await Follow.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('GET /suggestions/people', () => {
    it('surfaces friends-of-friends the brand does not already follow', async () => {
      const brand = await makeVendor('Bushfire');
      const friend = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Friend', username: 'friend_a' });
      const suggestion = await Buyer.create({ phone: '+26878000022', password: 'secret1', name: 'Suggested', username: 'sugg_b' });
      // brand (vendor) -> friend (buyer); friend -> suggestion (buyer)
      await Follow.create({ followerType: 'vendor', followerId: brand._id, targetType: 'buyer', targetId: friend._id });
      await Follow.create({ followerType: 'buyer', followerId: friend._id, targetType: 'buyer', targetId: suggestion._id });

      const res = await request(app)
        .get('/api/tickets/social/suggestions/people')
        .set('Authorization', `Bearer ${signVendorToken(String(brand._id))}`)
        .expect(200);
      const usernames = res.body.data.map((p: any) => p.username);
      expect(usernames).toContain('sugg_b');
      expect(usernames).not.toContain('friend_a'); // already followed by the brand
    });

    it('falls back to recently-active buyers when the brand follows no one, mutualCount 0', async () => {
      const brand = await makeVendor('New Brand');
      await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Other', username: 'other_a', lastLoginAt: new Date() });

      const res = await request(app)
        .get('/api/tickets/social/suggestions/people')
        .set('Authorization', `Bearer ${signVendorToken(String(brand._id))}`)
        .expect(200);
      const row = res.body.data.find((p: any) => p.username === 'other_a');
      expect(row).toBeTruthy();
      expect(row.mutualCount).toBe(0);
    });

    it('401s for a buyer token (vendor-only surface)', async () => {
      await Buyer.create({ phone: '+26878422613', password: 'secret1', name: 'Me', username: 'me_one' });
      await request(app)
        .get('/api/tickets/social/suggestions/people')
        .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`)
        .expect(401);
    });

    it('401s when anonymous', async () => {
      await request(app).get('/api/tickets/social/suggestions/people').expect(401);
    });
  });

  describe('GET /suggestions/organizers', () => {
    it('lists other verified organizers and never the brand itself', async () => {
      const me = await makeVendor('Self Brand');
      const other = await makeVendor('Other Brand');
      const follower = await Buyer.create({ phone: '+26878000031', password: 'secret1', name: 'Fan', username: 'fan_a' });
      await Follow.create({ followerType: 'buyer', followerId: follower._id, targetType: 'organizer', targetId: other._id });

      const res = await request(app)
        .get('/api/tickets/social/suggestions/organizers')
        .set('Authorization', `Bearer ${signVendorToken(String(me._id))}`)
        .expect(200);
      const ids = res.body.data.map((o: any) => o.id);
      expect(ids).toContain(String(other._id));
      expect(ids).not.toContain(String(me._id)); // never suggest self
    });

    it('marks isFollowing true for an organizer the brand already follows', async () => {
      const me = await makeVendor('Follower Brand');
      const other = await makeVendor('Followed Brand');
      await Follow.create({ followerType: 'vendor', followerId: me._id, targetType: 'organizer', targetId: other._id });

      const res = await request(app)
        .get('/api/tickets/social/suggestions/organizers')
        .set('Authorization', `Bearer ${signVendorToken(String(me._id))}`)
        .expect(200);
      const row = res.body.data.find((o: any) => o.id === String(other._id));
      expect(row.isFollowing).toBe(true);
    });
  });

  describe('GET /recommendations', () => {
    it('returns soonest-upcoming events with a null basis (a brand has no saved list)', async () => {
      const me = await makeVendor('Reco Brand');
      const host = await makeVendor('Host Brand');
      await Event.create({ vendorId: host._id, name: 'Upcoming Show', venue: 'V', eventDate: soon(120), startTime: soon(120), endTime: soon(180), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }] });

      const res = await request(app)
        .get('/api/tickets/social/recommendations')
        .set('Authorization', `Bearer ${signVendorToken(String(me._id))}`)
        .expect(200);
      expect(res.body.data.basisEvent).toBeNull();
      const names = res.body.data.events.map((e: any) => e.name);
      expect(names).toContain('Upcoming Show');
    });
  });

  describe('nearby + location', () => {
    it('PATCH /me/location stores the brand location, DELETE clears it', async () => {
      const me = await makeVendor('Geo Brand');
      const token = `Bearer ${signVendorToken(String(me._id))}`;

      await request(app).patch('/api/tickets/social/me/location').set('Authorization', token).send({ lat: 0, lng: 0 }).expect(200);
      const withLoc = await Vendor.findById(me._id);
      expect(withLoc?.location?.coordinates).toEqual([0, 0]);

      await request(app).delete('/api/tickets/social/me/location').set('Authorization', token).expect(200);
      const cleared = await Vendor.findById(me._id);
      expect(cleared?.location).toBeUndefined();
    });

    it('GET /nearby/people returns nearby buyers with a distance', async () => {
      const me = await makeVendor('Nearby Brand');
      await Buyer.create({
        phone: '+26878000041', password: 'secret1', name: 'Close', username: 'close_a',
        location: { type: 'Point', coordinates: [0, 0.01] }, locationUpdatedAt: new Date(),
      });

      const res = await request(app)
        .get('/api/tickets/social/nearby/people')
        .query({ lat: 0, lng: 0 })
        .set('Authorization', `Bearer ${signVendorToken(String(me._id))}`)
        .expect(200);
      const usernames = res.body.data.people.map((p: any) => p.username);
      expect(usernames).toContain('close_a');
      const row = res.body.data.people.find((p: any) => p.username === 'close_a');
      expect(typeof row.distanceKm).toBe('number');
    });

    it('400s on out-of-range lat', async () => {
      const me = await makeVendor('Bad Geo Brand');
      await request(app)
        .get('/api/tickets/social/nearby/people')
        .query({ lat: 200, lng: 0 })
        .set('Authorization', `Bearer ${signVendorToken(String(me._id))}`)
        .expect(400);
    });
  });
});
