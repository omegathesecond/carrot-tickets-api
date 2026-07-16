import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

// This repo's test suite is Jest (see jest.config.js / package.json "test": "jest"),
// not vitest — mirrors the mocking style already used in wristbandMedia.route.test.ts
// (jest.mock('@utils/r2.service', ...factory...)) rather than vi.mock/vi.spyOn.
jest.mock('@utils/r2.service', () => ({
  R2Service: {
    generateMediaKey: jest.fn((folder: string, name: string) => `${folder}/123-${name}`),
    uploadBufferToR2: jest.fn(async () => ({})),
    getPublicUrl: jest.fn((key: string) => `https://cdn.test/${key}`),
    deleteEventMediaByUrl: jest.fn(async () => undefined),
  },
}));

import { R2Service } from '@utils/r2.service';

const JWT_SECRET = process.env['JWT_SECRET'] || 'test-secret-key';

function signVendorToken(vendorId: string, permissions: string[] = [TicketsPermission.EDIT_EVENT]): string {
  return jwt.sign(
    { app: 'tickets', vendorId, userType: 'vendor', isSuperAdmin: false, role: 'owner', permissions },
    JWT_SECRET
  );
}

async function seedVendor() {
  return Vendor.create({
    businessName: 'Carrot Live',
    email: 'org-logo@example.com',
    password: 'secret123',
    phoneNumber: '+26878000097',
  });
}

describe('POST /api/tickets/organizer/profile/logo', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('uploads the logo to R2 and returns the public URL', async () => {
    const vendor = await seedVendor();
    const res = await request(app)
      .post('/api/tickets/organizer/profile/logo')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
      .attach('logo', Buffer.from('fakeimage'), { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.data.logoUrl).toContain(`/vendors/${String(vendor._id)}/logo/`);
    expect(R2Service.uploadBufferToR2).toHaveBeenCalledTimes(1);
  });

  it('400s when no file is attached', async () => {
    const vendor = await seedVendor();
    const res = await request(app)
      .post('/api/tickets/organizer/profile/logo')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`);

    expect(res.status).toBe(400);
  });
});
