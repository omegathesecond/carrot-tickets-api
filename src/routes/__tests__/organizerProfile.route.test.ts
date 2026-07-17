import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

function signVendorToken(vendorId: string, permissions: string[] = [TicketsPermission.EDIT_BRAND]): string {
  return jwt.sign(
    { app: 'tickets', vendorId, userType: 'vendor', isSuperAdmin: false, role: 'owner', permissions },
    JWT_SECRET
  );
}

async function seedVendor() {
  return Vendor.create({
    businessName: 'Piano Republic Events',
    email: 'org@example.com',
    password: 'secret123',
    phoneNumber: '+26878000099',
  });
}

describe('organizer own-profile update', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('vendor sets logoUrl and bio; response never leaks email/phone', async () => {
    const vendor = await seedVendor();
    const res = await request(app)
      .patch('/api/tickets/organizer/profile')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
      .send({ logoUrl: 'https://cdn.example.com/logo.png', bio: 'We throw the best shows in Mbabane.' })
      .expect(200);

    expect(res.body.data.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(res.body.data.bio).toBe('We throw the best shows in Mbabane.');
    expect(JSON.stringify(res.body.data)).not.toContain('org@example.com');
    expect(JSON.stringify(res.body.data)).not.toContain('+26878000099');

    const reloaded = await Vendor.findById(vendor._id);
    expect(reloaded!.logoUrl).toBe('https://cdn.example.com/logo.png');
  });

  it('validation: empty body 400, bad url 400, missing permission 403, no auth 401', async () => {
    const vendor = await seedVendor();
    const auth = `Bearer ${signVendorToken(String(vendor._id))}`;
    await request(app).patch('/api/tickets/organizer/profile').set('Authorization', auth).send({}).expect(400);
    await request(app).patch('/api/tickets/organizer/profile').set('Authorization', auth)
      .send({ logoUrl: 'not-a-url' }).expect(400);
    await request(app).patch('/api/tickets/organizer/profile').set('Authorization', auth)
      .send({ logoUrl: 'javascript:alert(1)' }).expect(400);
    await request(app).patch('/api/tickets/organizer/profile')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id), [])}`)
      .send({ bio: 'x' }).expect(403);
    await request(app).patch('/api/tickets/organizer/profile').send({ bio: 'x' }).expect(401);
  });

  it('403s a token that carries EDIT_EVENT but not EDIT_BRAND — brand identity is a different axis than events', async () => {
    const vendor = await seedVendor();
    await request(app)
      .patch('/api/tickets/organizer/profile')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id), [TicketsPermission.EDIT_EVENT])}`)
      .send({ bio: 'x' })
      .expect(403);
  });
});
