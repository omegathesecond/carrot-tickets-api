import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Vendor } from '@models/vendor.model';

describe('public events list — organizer identity', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('includes organizer { id, businessName, logoUrl } for an active vendor, with no PII leaked', async () => {
    const vendor = await Vendor.create({
      businessName: 'Piano Republic Events',
      email: 'org-list@example.com',
      phoneNumber: '+26878000199',
      password: 'secret123',
      logoUrl: 'https://cdn.example.com/logo.png',
      keshlessVendorId: 'KV-99999',
    });
    const seeded = await seedPublishedEvent({ vendorId: vendor._id as any });

    const res = await request(app).get('/api/public/events').expect(200);
    const event = res.body.data.events.find((e: any) => e._id === seeded.eventId);
    expect(event).toBeDefined();
    expect(event.organizer).toEqual({
      id: String(vendor._id),
      businessName: 'Piano Republic Events',
      logoUrl: 'https://cdn.example.com/logo.png',
    });
    expect(JSON.stringify(res.body.data)).not.toContain('org-list@example.com');
    expect(JSON.stringify(res.body.data)).not.toContain('+26878000199');
    expect(JSON.stringify(res.body.data)).not.toContain('KV-99999');
    expect(event.vendorId).toBeUndefined();
  });

  it('organizer is null for an inactive vendor — never throws on a public surface', async () => {
    const vendor = await Vendor.create({
      businessName: 'Gone Events List',
      email: 'gone-list@example.com',
      phoneNumber: '+26878000198',
      password: 'secret123',
      isActive: false,
    });
    const seeded = await seedPublishedEvent({ vendorId: vendor._id as any });

    const res = await request(app).get('/api/public/events').expect(200);
    const event = res.body.data.events.find((e: any) => e._id === seeded.eventId);
    expect(event).toBeDefined();
    expect(event.organizer).toBeNull();
  });

  it('organizer is null when the vendor no longer exists', async () => {
    const seeded = await seedPublishedEvent(); // random, never-created vendorId

    const res = await request(app).get('/api/public/events').expect(200);
    const event = res.body.data.events.find((e: any) => e._id === seeded.eventId);
    expect(event).toBeDefined();
    expect(event.organizer).toBeNull();
  });

  it('batches vendor lookups into a single query for multiple events sharing a vendor', async () => {
    const vendor = await Vendor.create({
      businessName: 'Shared Organizer',
      email: 'shared-list@example.com',
      phoneNumber: '+26878000197',
      password: 'secret123',
    });
    const findSpy = jest.spyOn(Vendor, 'find');

    const seededA = await seedPublishedEvent({ vendorId: vendor._id as any });
    const seededB = await seedPublishedEvent({ vendorId: vendor._id as any });

    const res = await request(app).get('/api/public/events').expect(200);
    const eventA = res.body.data.events.find((e: any) => e._id === seededA.eventId);
    const eventB = res.body.data.events.find((e: any) => e._id === seededB.eventId);
    expect(eventA.organizer.businessName).toBe('Shared Organizer');
    expect(eventB.organizer.businessName).toBe('Shared Organizer');
    expect(findSpy).toHaveBeenCalledTimes(1);

    findSpy.mockRestore();
  });
});
