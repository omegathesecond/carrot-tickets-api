import request from 'supertest';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signAdminSessionToken, seedVendorSessionToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

let seq = 0;
async function makeVendor(businessType: string) {
  seq += 1;
  return Vendor.create({ businessName: `Biz ${seq}`, email: `biz${seq}@x.co`, password: 'secret1', businessType });
}

describe('GET /api/tickets/venue', () => {
  it('a venue-type vendor not yet switched on: eligible, venue null', async () => {
    const v = await makeVendor('venue');
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${await seedVendorSessionToken(String(v._id))}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ venue: null, eligible: true });
  });

  it('a suspended venue comes back suspended', async () => {
    const v = await makeVendor('venue');
    await Venue.create({ vendorId: v._id, name: 'Lounge', currency: 'SZL', status: 'suspended', activatedBy: 'admin' });
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${await seedVendorSessionToken(String(v._id))}`);
    expect(res.body.data.eligible).toBe(true);
    expect(res.body.data.venue).toMatchObject({ name: 'Lounge', currency: 'SZL', status: 'suspended' });
  });

  it('an event organizer with no venue is not eligible', async () => {
    const v = await makeVendor('event_organizer');
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${await seedVendorSessionToken(String(v._id))}`);
    expect(res.body.data).toEqual({ venue: null, eligible: false });
  });

  it("a sub-user sees their vendor's venue", async () => {
    const v = await makeVendor('venue');
    await Venue.create({ vendorId: v._id, name: 'Lounge', currency: 'ZAR', activatedBy: 'admin' });
    const token = await seedVendorSessionToken(String(v._id), {
      permissions: ['tickets:view_events'],
    });
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.venue).toMatchObject({ name: 'Lounge', status: 'active' });
  });

  it('the platform super-admin (non-ObjectId vendorId in tests) is simply not a venue — 200, not a 500', async () => {
    const res = await request(app).get('/api/tickets/venue').set('Authorization', `Bearer ${await signAdminSessionToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ venue: null, eligible: false });
  });

  it('401s without a token', async () => {
    const res = await request(app).get('/api/tickets/venue');
    expect(res.status).toBe(401);
  });
});
