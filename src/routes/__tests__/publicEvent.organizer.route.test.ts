import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Vendor } from '@models/vendor.model';

describe('public event detail — organizer identity', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('includes organizer { id, businessName, logoUrl } for an active vendor, with no PII leaked', async () => {
    const vendor = await Vendor.create({
      businessName: 'Piano Republic Events',
      email: 'org@example.com',
      phoneNumber: '+26878000099',
      password: 'secret123',
      logoUrl: 'https://cdn.example.com/logo.png',
      keshlessVendorId: 'KV-12345',
    });
    const seeded = await seedPublishedEvent({ vendorId: vendor._id as any });

    const res = await request(app).get(`/api/public/events/${seeded.eventId}`).expect(200);
    expect(res.body.data.organizer).toEqual({
      id: String(vendor._id),
      businessName: 'Piano Republic Events',
      logoUrl: 'https://cdn.example.com/logo.png',
    });
    expect(JSON.stringify(res.body.data)).not.toContain('org@example.com');
    expect(JSON.stringify(res.body.data)).not.toContain('+26878000099');
    expect(JSON.stringify(res.body.data)).not.toContain('KV-12345');
  });

  it('organizer is null for an inactive vendor — never throws on a public surface', async () => {
    const vendor = await Vendor.create({
      businessName: 'Gone Events',
      email: 'gone@example.com',
      phoneNumber: '+26878000098',
      password: 'secret123',
      isActive: false,
    });
    const seeded = await seedPublishedEvent({ vendorId: vendor._id as any });

    const res = await request(app).get(`/api/public/events/${seeded.eventId}`).expect(200);
    expect(res.body.data.organizer).toBeNull();
  });

  it('organizer is null when the vendor no longer exists', async () => {
    const seeded = await seedPublishedEvent(); // random, never-created vendorId

    const res = await request(app).get(`/api/public/events/${seeded.eventId}`).expect(200);
    expect(res.body.data.organizer).toBeNull();
  });
});
