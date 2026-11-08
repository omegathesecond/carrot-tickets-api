import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedVendorSessionToken, signBuyerSessionToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { ProfileVisit } from '@models/profileVisit.model';
import { randomUUID } from 'crypto';

describe('unique profile visitors', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);
  const buyer = () => Buyer.create({ phone: '+26878422613', password: 'secret123' });
  const vendor = () => Vendor.create({ businessName: 'Venue', email: 'venue@example.com', password: 'secret123' });
  function visit(type: string, id: unknown, visitorId: string, token?: string) {
    const req = request(app).post(`/api/public/profiles/${type}/${id}/views`).send({ visitorId });
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }
  it('deduplicates concurrent guest loads and counts a second visitor once', async () => {
    const target = await buyer();
    const browser = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => visit('buyer', target._id, browser)));
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(await ProfileVisit.countDocuments()).toBe(1);
    expect((await visit('buyer', target._id, randomUUID())).body.data.profileViewCount).toBe(2);
  });
  it('counts an account once across browsers, promotes guest visits, and survives sign-out', async () => {
    const target = await vendor(); const viewer = await buyer();
    const browser = randomUUID();
    const token = await signBuyerSessionToken(viewer.phone!);
    expect((await visit('vendor', target._id, browser)).body.data.profileViewCount).toBe(1);
    expect((await visit('vendor', target._id, browser, token)).body.data.profileViewCount).toBe(1);
    expect((await visit('vendor', target._id, randomUUID(), token)).body.data.profileViewCount).toBe(1);
    expect((await visit('vendor', target._id, browser)).body.data.profileViewCount).toBe(1);
  });
  it('excludes buyer self-views, including a previous guest view', async () => {
    const owner = await buyer(); const browser = randomUUID();
    await visit('buyer', owner._id, browser);
    expect((await visit('buyer', String(owner._id).toUpperCase(), browser.toUpperCase(), await signBuyerSessionToken(owner.phone!))).body.data.profileViewCount).toBe(0);
  });
  it('excludes vendor self-views for any operator and shares the count across profile surfaces', async () => {
    const owner = await vendor();
    const token = await seedVendorSessionToken(String(owner._id));
    expect((await visit('vendor', owner._id, randomUUID(), token)).body.data.profileViewCount).toBe(0);
    expect((await visit('vendor', owner._id, randomUUID())).body.data.profileViewCount).toBe(1);
    expect((await visit('vendor', owner._id, randomUUID(), token)).body.data.profileViewCount).toBe(1);
  });
  it('reconciles guest history on another profile and concurrent signed-in loads', async () => {
    const target = await vendor(); const viewer = await buyer(); const browser = randomUUID();
    await visit('vendor', target._id, browser);
    const token = await signBuyerSessionToken(viewer.phone!);
    // Signing in on any profile associates the guest history with the account.
    const responses = await Promise.all(Array.from({ length: 8 }, () => visit('buyer', viewer._id, browser, token)));
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect((await visit('vendor', target._id, randomUUID(), token)).body.data.profileViewCount).toBe(1);
  });
  it('rejects missing/invalid targets, visitor IDs, inactive brands and invalid credentials', async () => {
    const target = await vendor();
    await visit('vendor', target._id, '').expect(400);
    await visit('other', target._id, randomUUID()).expect(400);
    await visit('buyer', 'bad', randomUUID()).expect(400);
    await visit('buyer', 'aaaaaaaaaaaaaaaaaaaaaaaa', randomUUID()).expect(404);
    await visit('vendor', target._id, randomUUID(), 'invalid').expect(401);
    await Vendor.updateOne({ _id: target._id }, { $set: { isActive: false } });
    await visit('vendor', target._id, randomUUID()).expect(404);
    expect(await ProfileVisit.countDocuments()).toBe(0);
  });
  it('surfaces storage failures instead of returning a successful zero', async () => {
    const target = await buyer();
    const spy = jest.spyOn(ProfileVisit, 'aggregate').mockRejectedValueOnce(new Error('storage unavailable'));
    try { await visit('buyer', target._id, randomUUID()).expect(500); } finally { spy.mockRestore(); }
  });
});
