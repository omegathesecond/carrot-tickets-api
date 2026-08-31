import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Follow } from '@models/follow.model';
import { VerificationStatus } from '@interfaces/vendor.interface';
import { EventStatus } from '@interfaces/event.interface';

const PHONE = '+26878422613';

describe('GET /api/social/suggestions/organizers', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('lists active verified organizers with follower/event counts and isFollowing', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    await Vendor.create({ businessName: 'MTN Bushfire', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data[0]).toMatchObject({ businessName: 'MTN Bushfire', followerCount: 0, eventCount: 0, isFollowing: false });
  });

  it('shapes the DTO correctly, including a null location when no address is set', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const vendor = await Vendor.create({
      businessName: 'MTN Bushfire', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED,
      logoUrl: 'https://cdn.example.com/logo.png', address: { city: 'Manzini' },
    });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data[0]).toEqual({
      id: String(vendor._id),
      businessName: 'MTN Bushfire',
      logoUrl: 'https://cdn.example.com/logo.png',
      location: 'Manzini',
      eventCount: 0,
      followerCount: 0,
      isFollowing: false,
    });
  });

  it('defaults location to null when the vendor has no address.city', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    await Vendor.create({ businessName: 'No Address Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    expect(res.body.data[0].location).toBeNull();
  });

  it('counts only PUBLISHED events toward eventCount', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const vendor = await Vendor.create({ businessName: 'Org A', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    await Event.create({ vendorId: vendor._id, name: 'Published Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });
    await Event.create({ vendorId: vendor._id, name: 'Draft Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), status: EventStatus.DRAFT, ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const row = res.body.data.find((o: any) => o.id === String(vendor._id));
    expect(row.eventCount).toBe(1);
  });

  it('marks isFollowing true for organizers the buyer already follows, but still includes them', async () => {
    const me = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const followed = await Vendor.create({ businessName: 'Followed Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'organizer', targetId: followed._id });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const row = res.body.data.find((o: any) => o.id === String(followed._id));
    expect(row).toBeTruthy();
    expect(row.isFollowing).toBe(true);
  });

  it('prioritises organizers the buyer is not already following ahead of ones it does, even when the followed one has more followers/events', async () => {
    const me = await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const followed = await Vendor.create({ businessName: 'Followed Popular Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    const notFollowed = await Vendor.create({ businessName: 'Unfollowed Quiet Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    await Event.create({ vendorId: followed._id, name: 'Big Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'organizer', targetId: followed._id });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const order = res.body.data.map((o: any) => o.id);
    expect(order.indexOf(String(notFollowed._id))).toBeLessThan(order.indexOf(String(followed._id)));
  });

  it('rotates in a brand-new organizer that would otherwise be crowded out of the seeded pool by established organizers', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    // A wall of established organizers, each with a published event — exactly
    // enough (60) to fill the default POOL_SIZE ahead of a brand-new,
    // eventless organizer sorted purely by eventCount/followerCount, so the
    // brand-new one is guaranteed to fall outside the established pool.
    for (let i = 0; i < 60; i++) {
      const established = await Vendor.create({ businessName: `Established Org ${i}`, password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
      await Event.create({ vendorId: established._id, name: `Show ${i}`, venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });
    }
    const brandNew = await Vendor.create({ businessName: 'Brand New Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });

    // Walk every page at a limit small enough (<=20) to keep POOL_SIZE
    // pinned at its 60 floor — a bigger limit would inflate POOL_SIZE past
    // 61 and trivially include the brand-new org without exercising the
    // top-up path at all. Collecting the union across pages (rather than
    // asserting on one page) keeps the test independent of exactly where the
    // seeded shuffle happens to place it.
    const token = signBuyerToken(PHONE);
    const seen = new Set<string>();
    for (let page = 1; page <= 4; page++) {
      const res = await request(app)
        .get(`/api/social/suggestions/organizers?seed=7&limit=20&page=${page}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      for (const o of res.body.data) seen.add(o.id);
    }
    expect(seen.has(String(brandNew._id))).toBe(true);
  });

  it('ranks organizers with more followers higher', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const popular = await Vendor.create({ businessName: 'Popular Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    const quiet = await Vendor.create({ businessName: 'Quiet Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    const fan1 = await Buyer.create({ phone: '+26878000021', password: 'secret1', name: 'Fan1' });
    const fan2 = await Buyer.create({ phone: '+26878000022', password: 'secret1', name: 'Fan2' });
    await Follow.create({ followerType: 'buyer', followerId: fan1._id, targetType: 'organizer', targetId: popular._id });
    await Follow.create({ followerType: 'buyer', followerId: fan2._id, targetType: 'organizer', targetId: popular._id });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const popularIndex = res.body.data.findIndex((o: any) => o.id === String(popular._id));
    const quietIndex = res.body.data.findIndex((o: any) => o.id === String(quiet._id));
    expect(res.body.data[popularIndex].followerCount).toBe(2);
    expect(popularIndex).toBeLessThan(quietIndex);
  });

  it('ranks organizers by real follower count across more than a trivial set (proves aggregation ranking, not insertion order)', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    // Seeded in an order that does NOT match the expected rank order, so a
    // bug that ranks by insertion/creation order instead of real
    // followerCount would fail this test.
    const mid = await Vendor.create({ businessName: 'Mid Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    const top = await Vendor.create({ businessName: 'Top Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    const low = await Vendor.create({ businessName: 'Low Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });

    const fanCounts: Array<[typeof mid, number]> = [[mid, 5], [top, 8], [low, 2]];
    let phoneSuffix = 100;
    for (const [vendor, count] of fanCounts) {
      for (let i = 0; i < count; i++) {
        const fan = await Buyer.create({ phone: `+2687840${phoneSuffix++}`, password: 'secret1', name: `Fan${phoneSuffix}` });
        await Follow.create({ followerType: 'buyer', followerId: fan._id, targetType: 'organizer', targetId: vendor._id });
      }
    }

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const byId = (id: string) => res.body.data.find((o: any) => o.id === id);
    const topRow = byId(String(top._id));
    const midRow = byId(String(mid._id));
    const lowRow = byId(String(low._id));

    expect(topRow.followerCount).toBe(8);
    expect(midRow.followerCount).toBe(5);
    expect(lowRow.followerCount).toBe(2);

    const order = res.body.data.map((o: any) => o.id);
    expect(order.indexOf(String(top._id))).toBeLessThan(order.indexOf(String(mid._id)));
    expect(order.indexOf(String(mid._id))).toBeLessThan(order.indexOf(String(low._id)));
  });

  it('ranks a newer organizer with a published event ahead of an older, eventless one when both have 0 followers', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    // Created first, so it would win an ascending-_id tiebreak — but it has
    // no events, so it must not outrank the newer organizer below it.
    const oldDormant = await Vendor.create({ businessName: 'Old Dormant Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    const newActive = await Vendor.create({ businessName: 'New Active Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    await Event.create({ vendorId: newActive._id, name: 'Fresh Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const order = res.body.data.map((o: any) => o.id);
    expect(order.indexOf(String(newActive._id))).toBeLessThan(order.indexOf(String(oldDormant._id)));
  });

  it('ranks a new organizer with a published event ahead of a dormant organizer that has followers but no events', async () => {
    // Reproduces the reported bug: a brand-new organizer starts at 0
    // followers by definition, so ranking by followerCount first (even with
    // an eventCount tiebreak) still buried them behind ANY organizer with
    // even a handful of stale followers and zero events.
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    const dormantWithFollowers = await Vendor.create({ businessName: 'Dormant With Followers', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    const newOrganizer = await Vendor.create({ businessName: 'Brand New Organizer', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    for (let i = 0; i < 8; i++) {
      const fan = await Buyer.create({ phone: `+2687841${100 + i}`, password: 'secret1', name: `Fan${i}` });
      await Follow.create({ followerType: 'buyer', followerId: fan._id, targetType: 'organizer', targetId: dormantWithFollowers._id });
    }
    await Event.create({ vendorId: newOrganizer._id, name: 'First Show', venue: 'V', eventDate: new Date(), startTime: new Date(), endTime: new Date(), status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 0, quantity: 10, available: 10 }] });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const order = res.body.data.map((o: any) => o.id);
    expect(order.indexOf(String(newOrganizer._id))).toBeLessThan(order.indexOf(String(dormantWithFollowers._id)));
  });

  it('excludes inactive and unverified vendors', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    await Vendor.create({ businessName: 'Inactive Org', password: 'secret1', isActive: false, verificationStatus: VerificationStatus.VERIFIED });
    await Vendor.create({ businessName: 'Pending Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.PENDING });
    await Vendor.create({ businessName: 'Rejected Org', password: 'secret1', isActive: true, verificationStatus: VerificationStatus.REJECTED });

    const res = await request(app).get('/api/social/suggestions/organizers').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const names = res.body.data.map((o: any) => o.businessName);
    expect(names).not.toContain('Inactive Org');
    expect(names).not.toContain('Pending Org');
    expect(names).not.toContain('Rejected Org');
  });

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/suggestions/organizers').expect(401);
  });

  it('supports limit/page pagination, disjoint pages', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    for (let i = 0; i < 5; i++) {
      await Vendor.create({ businessName: `Org ${i}`, password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    }

    const page1 = await request(app).get('/api/social/suggestions/organizers?limit=2&page=1').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);
    const page2 = await request(app).get('/api/social/suggestions/organizers?limit=2&page=2').set('Authorization', `Bearer ${signBuyerToken(PHONE)}`).expect(200);

    expect(page1.body.data).toHaveLength(2);
    expect(page2.body.data).toHaveLength(2);
    const ids1 = page1.body.data.map((o: any) => o.id);
    const ids2 = page2.body.data.map((o: any) => o.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });

  it('with a seed, returns the same order for the same seed', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    for (let i = 0; i < 6; i++) {
      await Vendor.create({ businessName: `Org ${i}`, password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    }
    const token = signBuyerToken(PHONE);
    const a = await request(app).get('/api/social/suggestions/organizers?seed=12345').set('Authorization', `Bearer ${token}`).expect(200);
    const b = await request(app).get('/api/social/suggestions/organizers?seed=12345').set('Authorization', `Bearer ${token}`).expect(200);
    expect(a.body.data.map((o: any) => o.id)).toEqual(b.body.data.map((o: any) => o.id));
  });

  it('with different seeds, returns different orders', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    for (let i = 0; i < 10; i++) {
      await Vendor.create({ businessName: `Org ${i}`, password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    }
    const token = signBuyerToken(PHONE);
    const a = await request(app).get('/api/social/suggestions/organizers?seed=1').set('Authorization', `Bearer ${token}`).expect(200);
    const b = await request(app).get('/api/social/suggestions/organizers?seed=2').set('Authorization', `Bearer ${token}`).expect(200);
    // 10! permutations — a collision between two seeds is astronomically unlikely.
    expect(a.body.data.map((o: any) => o.id)).not.toEqual(b.body.data.map((o: any) => o.id));
  });

  it('with a fixed seed, paginates without overlap across pages', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', name: 'Me' });
    for (let i = 0; i < 6; i++) {
      await Vendor.create({ businessName: `Org ${i}`, password: 'secret1', isActive: true, verificationStatus: VerificationStatus.VERIFIED });
    }
    const token = signBuyerToken(PHONE);
    const p1 = await request(app).get('/api/social/suggestions/organizers?seed=42&limit=2&page=1').set('Authorization', `Bearer ${token}`).expect(200);
    const p2 = await request(app).get('/api/social/suggestions/organizers?seed=42&limit=2&page=2').set('Authorization', `Bearer ${token}`).expect(200);
    const ids1 = p1.body.data.map((o: any) => o.id);
    const ids2 = p2.body.data.map((o: any) => o.id);
    expect(ids1).toHaveLength(2);
    expect(ids2).toHaveLength(2);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });
});
