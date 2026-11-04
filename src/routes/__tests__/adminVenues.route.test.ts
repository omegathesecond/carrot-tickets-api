import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signSuperAdminToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { GateOperator } from '@models/gateOperator.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const admin = () => `Bearer ${signSuperAdminToken()}`;
let seq = 0;
async function makeVendor(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return Vendor.create({ businessName: `Lounge ${seq}`, email: `lounge${seq}@x.co`, password: 'secret1', businessType: 'venue', ...overrides });
}

describe('POST /api/tickets/admin/venues', () => {
  it('switches venue trading on: 201 with the summary, stamped with the admin', async () => {
    const v = await makeVendor();
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', admin())
      .send({ vendorId: String(v._id), name: 'Kwa-Linda Lounge', currency: 'SZL' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Kwa-Linda Lounge', currency: 'SZL', status: 'active' });
    expect(res.body.data.id).toMatch(/^[0-9a-f]{24}$/);
    const stored = await Venue.findOne({ vendorId: v._id }).lean();
    expect(stored?.activatedBy).toBe('admin-vendor-id');
  });

  it('409s a second switch-on and keeps exactly one venue', async () => {
    const v = await makeVendor();
    const body = { vendorId: String(v._id), name: 'A', currency: 'SZL' };
    expect((await request(app).post('/api/tickets/admin/venues').set('Authorization', admin()).send(body)).status).toBe(201);
    const second = await request(app).post('/api/tickets/admin/venues').set('Authorization', admin()).send(body);
    expect(second.status).toBe(409);
    expect(second.body.message).toBe('This vendor already has a venue');
    expect(await Venue.countDocuments({ vendorId: v._id })).toBe(1);
  });

  it('404s an unknown vendor', async () => {
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', admin())
      .send({ vendorId: new mongoose.Types.ObjectId().toHexString(), name: 'A', currency: 'SZL' });
    expect(res.status).toBe(404);
  });

  // Their permission set never includes tickets:manage_venue (see
  // scopePermissionsToType), so a switch-on would be a success nobody can see.
  it('409s a transport or services account and creates no venue', async () => {
    const transport = await makeVendor({ operatorType: 'transport' });
    const services = await makeVendor({ operatorType: 'services', serviceCategory: 'sound_hire' });
    for (const v of [transport, services]) {
      const res = await request(app)
        .post('/api/tickets/admin/venues')
        .set('Authorization', admin())
        .send({ vendorId: String(v._id), name: 'A', currency: 'SZL' });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Venue trading needs an events account');
    }
    expect(await Venue.countDocuments({})).toBe(0);
  });

  it('400s a currency outside SZL/ZAR and a blank name', async () => {
    const v = await makeVendor();
    for (const body of [
      { vendorId: String(v._id), name: 'A', currency: 'USD' },
      { vendorId: String(v._id), name: '  ', currency: 'SZL' },
    ]) {
      const res = await request(app).post('/api/tickets/admin/venues').set('Authorization', admin()).send(body);
      expect(res.status).toBe(400);
    }
    expect(await Venue.countDocuments({})).toBe(0);
  });

  it('403s a non-super-admin', async () => {
    const v = await makeVendor();
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', `Bearer ${signVendorToken(String(v._id))}`)
      .send({ vendorId: String(v._id), name: 'A', currency: 'SZL' });
    expect(res.status).toBe(403);
  });

  it('switches on via platform gate-operator token (userId, no vendorId)', async () => {
    const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
    const userId = '65f0000000000000000000aa';
    // Create a platform gate operator so requireSuperAdmin validates the row exists
    await GateOperator.create({
      _id: new mongoose.Types.ObjectId(userId),
      fullName: 'Platform Admin',
      loginCode: '999999',
      pin: '000000',
      scope: 'platform',
      isActive: true,
    });
    const token = jwt.sign(
      {
        app: 'tickets',
        userType: 'gate-operator',
        userId,
        isSuperAdmin: true,
        role: 'gate_operator',
        permissions: [],
      },
      JWT_SECRET,
    );
    const v = await makeVendor();
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ vendorId: String(v._id), name: 'Platform Gate On', currency: 'SZL' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Platform Gate On');
    const stored = await Venue.findOne({ vendorId: v._id }).lean();
    expect(stored?.activatedBy).toBe(userId);
  });

  it('401s when neither vendorId nor userId is present', async () => {
    const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
    const token = jwt.sign(
      {
        app: 'tickets',
        userType: 'gate-operator',
        isSuperAdmin: true,
        role: 'gate_operator',
        permissions: [],
      },
      JWT_SECRET,
    );
    const v = await makeVendor();
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ vendorId: String(v._id), name: 'A', currency: 'SZL' });
    expect(res.status).toBe(401);
    expect(await Venue.countDocuments({})).toBe(0);
  });
});

describe('PATCH /api/tickets/admin/venues/:id', () => {
  async function activeVenue() {
    const v = await makeVendor();
    const res = await request(app)
      .post('/api/tickets/admin/venues')
      .set('Authorization', admin())
      .send({ vendorId: String(v._id), name: 'A', currency: 'ZAR' });
    return res.body.data.id as string;
  }

  it('suspends and reactivates', async () => {
    const id = await activeVenue();
    const off = await request(app).patch(`/api/tickets/admin/venues/${id}`).set('Authorization', admin()).send({ status: 'suspended' });
    expect(off.status).toBe(200);
    expect(off.body.data.status).toBe('suspended');
    const on = await request(app).patch(`/api/tickets/admin/venues/${id}`).set('Authorization', admin()).send({ status: 'active' });
    expect(on.body.data.status).toBe('active');
  });

  it('404s an unknown venue and 400s an unknown status', async () => {
    const missing = await request(app)
      .patch(`/api/tickets/admin/venues/${new mongoose.Types.ObjectId().toHexString()}`)
      .set('Authorization', admin())
      .send({ status: 'suspended' });
    expect(missing.status).toBe(404);
    const id = await activeVenue();
    const bad = await request(app).patch(`/api/tickets/admin/venues/${id}`).set('Authorization', admin()).send({ status: 'closed' });
    expect(bad.status).toBe(400);
  });

  it('403s a non-super-admin', async () => {
    const id = await activeVenue();
    const res = await request(app)
      .patch(`/api/tickets/admin/venues/${id}`)
      .set('Authorization', `Bearer ${signVendorToken(new mongoose.Types.ObjectId().toHexString())}`)
      .send({ status: 'suspended' });
    expect(res.status).toBe(403);
  });
});
