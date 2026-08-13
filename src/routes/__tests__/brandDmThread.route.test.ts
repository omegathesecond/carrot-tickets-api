import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { DmThread } from '@models/dmThread.model';
import { DmThreadService } from '@services/dmThread.service';
import { BlockService } from '@services/block.service';
import { resetBuckets } from '@utils/rateLimit.util';

const PHONE = '+26878422613';

describe('buyer → brand DM thread (POST /api/dm/brand-threads)', () => {
  beforeAll(async () => {
    await connectTestDb();
    await DmThread.init(); // unique vendorPairKey index must exist before dedupe races it
  });
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seed() {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', username: 'alpha_one', name: 'Alpha' });
    const vendor = await Vendor.create({
      businessName: 'Loud Events', email: 'loud@example.com', password: 'secret123',
      phoneNumber: '+26878000055', logoUrl: null,
    });
    return { buyer, vendor, auth: `Bearer ${signBuyerToken(PHONE)}` };
  }

  it('opens a 1:1 with the brand — the view names the organizer, no contact leaks', async () => {
    const { vendor, auth } = await seed();
    const res = await request(app).post('/api/dm/brand-threads').set('Authorization', auth)
      .send({ vendorId: String(vendor._id) }).expect(201);
    expect(res.body.data.organizer).toMatchObject({ id: String(vendor._id), businessName: 'Loud Events' });
    // The buyer is the viewer, so the brand is `organizer` and `participants`
    // (the OTHER buyers) is empty — never the buyer themselves.
    expect(res.body.data.participants).toEqual([]);
    expect(JSON.stringify(res.body.data)).not.toContain('loud@example.com');
    expect(JSON.stringify(res.body.data)).not.toContain('+26878000055');
  });

  it('is idempotent AND dedupes with a brand-initiated thread (shared vendorPairKey)', async () => {
    const { buyer, vendor, auth } = await seed();
    // Brand opens first (the vendor-initiated path); the buyer endpoint must
    // then resolve to the SAME thread, not fork a second conversation.
    const brandThread = await DmThreadService.openVendorThread(String(vendor._id), String(buyer._id));
    const res = await request(app).post('/api/dm/brand-threads').set('Authorization', auth)
      .send({ vendorId: String(vendor._id) }).expect(201);
    expect(res.body.data.id).toBe(String(brandThread._id));

    const again = await request(app).post('/api/dm/brand-threads').set('Authorization', auth)
      .send({ vendorId: String(vendor._id) }).expect(201);
    expect(again.body.data.id).toBe(String(brandThread._id));
    expect(await DmThread.countDocuments({})).toBe(1);
  });

  it('404 unknown vendor, 404 inactive vendor, 400 malformed id', async () => {
    const { auth } = await seed();
    await request(app).post('/api/dm/brand-threads').set('Authorization', auth)
      .send({ vendorId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }).expect(404);
    await request(app).post('/api/dm/brand-threads').set('Authorization', auth)
      .send({ vendorId: 'nope' }).expect(400);
    const inactive = await Vendor.create({
      businessName: 'Gone', email: 'gone@example.com', password: 'secret123',
      phoneNumber: '+26878000066', isActive: false,
    });
    await request(app).post('/api/dm/brand-threads').set('Authorization', auth)
      .send({ vendorId: String(inactive._id) }).expect(404);
  });

  it('a block (either direction) refuses the thread (403)', async () => {
    const { buyer, vendor, auth } = await seed();
    await BlockService.block(buyer, String(vendor._id));
    await request(app).post('/api/dm/brand-threads').set('Authorization', auth)
      .send({ vendorId: String(vendor._id) }).expect(403);
  });

  it('requires a buyer session (401 without a token)', async () => {
    const { vendor } = await seed();
    await request(app).post('/api/dm/brand-threads')
      .send({ vendorId: String(vendor._id) }).expect(401);
  });
});
