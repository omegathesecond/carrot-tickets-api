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
});
