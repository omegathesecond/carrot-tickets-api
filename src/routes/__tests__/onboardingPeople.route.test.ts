import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerSessionToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { OnboardingService } from '@services/onboarding.service';
import { Follow } from '@models/follow.model';

describe('onboarding people pagination', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);
  it('reaches beyond 200 candidates, rotates by seed, and does not skip people after follows', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', username: 'viewer', avatarUrl: 'photo' });
    await Buyer.insertMany(Array.from({ length: 225 }, (_, i) => ({ phone: `+26879${String(i).padStart(6, '0')}`, username: `person_${i}`, password: 'test-password', avatarUrl: 'photo' })));
    const token = await signBuyerSessionToken('+26878422613');
    const page = async (n: number, seed = 123) => (await request(app).get(`/api/social/onboarding/people?category=users&page=${n}&limit=20&seed=${seed}`).set('Authorization', `Bearer ${token}`).expect(200)).body.data;
    const first = await page(1);
    expect(first.people).toHaveLength(20);
    expect((await page(1, 456)).people.map((p: { id: string }) => p.id)).not.toEqual(first.people.map((p: { id: string }) => p.id));
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: first.people[0].id });
    expect((await page(1)).people.map((p: { id: string }) => p.id)).not.toContain(first.people[0].id);
    const ids = first.people.map((p: { id: string }) => p.id);
    let more = first.hasMore;
    for (let n = 2; more; n++) {
      const result = await page(n);
      ids.push(...result.people.map((p: { id: string }) => p.id));
      more = result.hasMore;
      expect(n).toBeLessThan(20);
    }
    expect(ids).toHaveLength(225);
    expect(new Set(ids).size).toBe(225);
    expect(ids).not.toContain(String(me._id));
  });
  it('filters all four categories, excludes self/follows, and combines progress', async () => {
    const me = await Buyer.create({ phone: '+26878422613', password: 'secret1', username: 'viewer', avatarUrl: 'photo' });
    const user = await Buyer.create({ phone: '+26878000001', password: 'secret1', username: 'other' });
    const makeVendor = (slug: string, extra = {}) => Vendor.create({ businessName: slug, slug, password: 'secret1',
      isActive: true, verificationStatus: 'verified', operatorType: 'events', ...extra });
    const organizer = await makeVendor('organizer');
    const provider = await makeVendor('provider', { operatorType: 'services', serviceCategories: ['furniture_decor'] });
    const venue = await makeVendor('venue', { businessType: 'venue' });
    const activatedVenue = await makeVendor('activated-venue');
    await Venue.create({ vendorId: activatedVenue._id, name: 'Hall', currency: 'SZL', status: 'active', activatedAt: new Date(), activatedBy: me._id });
    await makeVendor('inactive', { isActive: false });
    const pendingOrganizer = await makeVendor('pending-organizer', { verificationStatus: 'pending' });
    const pendingProvider = await makeVendor('pending-provider', { verificationStatus: 'pending', operatorType: 'services', serviceCategories: ['furniture_decor'] });
    const pendingVenue = await makeVendor('pending-venue', { verificationStatus: 'pending', businessType: 'venue' });
    await makeVendor('rejected', { verificationStatus: 'rejected' });
    await makeVendor('suspended', { verificationStatus: 'suspended' });
    await makeVendor('admin', { isSuperAdmin: true });
    const token = await signBuyerSessionToken('+26878422613');
    const page = async (category: string) => (await request(app).get(`/api/social/onboarding/people?category=${category}&seed=123`)
      .set('Authorization', `Bearer ${token}`).expect(200)).body.data.people;
    expect((await page('users')).map((p: any) => p.id)).toEqual([String(user._id)]);
    expect((await page('users'))[0].avatarUrl).toBeNull();
    expect((await page('organizers')).find((p: any) => p.id === String(pendingOrganizer._id)).avatarUrl).toBeNull();
    expect(new Set((await page('organizers')).map((p: any) => p.id))).toEqual(new Set([String(organizer._id), String(pendingOrganizer._id)]));
    expect(new Set((await page('providers')).map((p: any) => p.id))).toEqual(new Set([String(provider._id), String(pendingProvider._id)]));
    expect(new Set((await page('venues')).map((p: any) => p.id))).toEqual(new Set([String(venue._id), String(activatedVenue._id), String(pendingVenue._id)]));
    for (const [targetType, targetId] of [['buyer', user._id], ['organizer', organizer._id], ['organizer', provider._id], ['organizer', venue._id], ['organizer', pendingOrganizer._id], ['organizer', pendingProvider._id], ['organizer', pendingVenue._id]]) {
      await Follow.create({ followerType: 'buyer', followerId: me._id, targetType, targetId });
    }
    for (const category of ['users', 'organizers', 'providers']) expect(await page(category)).toEqual([]);
    expect((await page('venues')).map((p: any) => p.id)).toEqual([String(activatedVenue._id)]);
    expect(await OnboardingService.status({ type: 'buyer', id: String(me._id) })).toMatchObject({ followingCount: 7, canBrowse: false });
    for (let i = 0; i < 3; i++) {
      const brand = await makeVendor(`extra-${i}`);
      await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'organizer', targetId: brand._id });
    }
    expect(await OnboardingService.status({ type: 'buyer', id: String(me._id) })).toMatchObject({ followingCount: 10, canBrowse: true });
    // Vendor actors cannot be suggested their own brand.
    expect((await (await import('@services/suggestions.service')).SuggestionsService.onboardingPeople(
      { type: 'vendor', id: String(provider._id) }, { category: 'providers', seed: 1 })).people.map((p) => p.id)).not.toContain(String(provider._id));
    await request(app).get('/api/social/onboarding/people?category=invalid&seed=123').set('Authorization', `Bearer ${token}`).expect(400);
  });

});
