import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import {
  VenueService,
  VenueAlreadyExistsError,
  VenueVendorNotFoundError,
  VenueNotFoundError,
  VenueOperatorTypeError,
} from '@services/venue.service';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

let seq = 0;
async function makeVendor(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return Vendor.create({
    businessName: `Venue Biz ${seq}`,
    email: `venue${seq}@x.co`,
    password: 'secret1',
    businessType: 'venue',
    ...overrides,
  });
}

describe('VenueService.activate', () => {
  it('creates an active venue stamped with who switched it on', async () => {
    const v = await makeVendor();
    const venue = await VenueService.activate({ vendorId: String(v._id), name: 'Kwa-Linda Lounge', currency: 'SZL', activatedBy: 'admin-1' });
    expect(venue.status).toBe('active');
    expect(venue.currency).toBe('SZL');
    expect(venue.activatedBy).toBe('admin-1');
    expect(venue.activatedAt).toBeInstanceOf(Date);
  });

  it('refuses a second venue for the same vendor, leaving exactly one', async () => {
    const v = await makeVendor();
    await VenueService.activate({ vendorId: String(v._id), name: 'A', currency: 'SZL', activatedBy: 'admin-1' });
    await expect(
      VenueService.activate({ vendorId: String(v._id), name: 'B', currency: 'ZAR', activatedBy: 'admin-1' }),
    ).rejects.toBeInstanceOf(VenueAlreadyExistsError);
    expect(await Venue.countDocuments({ vendorId: v._id })).toBe(1);
  });

  it('refuses an unknown vendor, a malformed id, and the platform super-admin account', async () => {
    const admin = await makeVendor({ isSuperAdmin: true });
    for (const vendorId of [new mongoose.Types.ObjectId().toHexString(), 'not-an-id', String(admin._id)]) {
      await expect(
        VenueService.activate({ vendorId, name: 'X', currency: 'SZL', activatedBy: 'admin-1' }),
      ).rejects.toBeInstanceOf(VenueVendorNotFoundError);
    }
    expect(await Venue.countDocuments({})).toBe(0);
  });

  // scopePermissionsToType strips tickets:manage_venue for these two operator
  // types, so a switch-on would "succeed" for a vendor who can never see the
  // section. Refuse it up front, and write nothing.
  it('refuses a transport or services vendor with VenueOperatorTypeError, writing nothing', async () => {
    const transport = await makeVendor({ operatorType: 'transport' });
    const services = await makeVendor({ operatorType: 'services', serviceCategory: 'sound_hire' });
    for (const v of [transport, services]) {
      await expect(
        VenueService.activate({ vendorId: String(v._id), name: 'X', currency: 'SZL', activatedBy: 'admin-1' }),
      ).rejects.toBeInstanceOf(VenueOperatorTypeError);
    }
    expect(await Venue.countDocuments({})).toBe(0);
  });

  it('allows an operatorType "both" vendor and an "events" one', async () => {
    const both = await makeVendor({ operatorType: 'both' });
    const events = await makeVendor({ operatorType: 'events' });
    for (const v of [both, events]) {
      const venue = await VenueService.activate({ vendorId: String(v._id), name: 'X', currency: 'SZL', activatedBy: 'admin-1' });
      expect(venue.status).toBe('active');
    }
    expect(await Venue.countDocuments({})).toBe(2);
  });

  it('allows a legacy vendor document with NO operatorType field (the schema default is events)', async () => {
    const v = await makeVendor();
    await Vendor.collection.updateOne({ _id: v._id }, { $unset: { operatorType: '' } });
    expect(await Vendor.collection.findOne({ _id: v._id, operatorType: { $exists: false } })).not.toBeNull();
    const venue = await VenueService.activate({ vendorId: String(v._id), name: 'Legacy', currency: 'SZL', activatedBy: 'admin-1' });
    expect(venue.name).toBe('Legacy');
  });
});

describe('VenueService.setStatus', () => {
  it('suspends and reactivates', async () => {
    const v = await makeVendor();
    const venue = await VenueService.activate({ vendorId: String(v._id), name: 'A', currency: 'SZL', activatedBy: 'admin-1' });
    expect((await VenueService.setStatus(String(venue._id), 'suspended')).status).toBe('suspended');
    expect((await VenueService.setStatus(String(venue._id), 'active')).status).toBe('active');
  });

  it('refuses an unknown or malformed venue id', async () => {
    await expect(VenueService.setStatus(new mongoose.Types.ObjectId().toHexString(), 'suspended')).rejects.toBeInstanceOf(VenueNotFoundError);
    await expect(VenueService.setStatus('nope', 'suspended')).rejects.toBeInstanceOf(VenueNotFoundError);
  });

  it('rejects invalid enum values (e.g., banana) and leaves status unchanged', async () => {
    const v = await makeVendor();
    const venue = await VenueService.activate({ vendorId: String(v._id), name: 'A', currency: 'SZL', activatedBy: 'admin-1' });
    await expect(VenueService.setStatus(String(venue._id), 'banana' as any)).rejects.toThrow();
    const stored = await Venue.findById(venue._id).lean();
    expect(stored?.status).toBe('active');
  });
});

describe('VenueService.forVendor', () => {
  it('a venue-type vendor with no venue yet is eligible with venue null', async () => {
    const v = await makeVendor();
    expect(await VenueService.forVendor(String(v._id))).toEqual({ venue: null, eligible: true });
  });

  it('an event organizer with no venue is not eligible', async () => {
    const v = await makeVendor({ businessType: 'event_organizer' });
    expect(await VenueService.forVendor(String(v._id))).toEqual({ venue: null, eligible: false });
  });

  it('any vendor with a venue is eligible and gets the summary', async () => {
    const v = await makeVendor({ businessType: 'event_organizer' });
    const venue = await VenueService.activate({ vendorId: String(v._id), name: 'Rooftop', currency: 'ZAR', activatedBy: 'admin-1' });
    const out = await VenueService.forVendor(String(v._id));
    expect(out.eligible).toBe(true);
    expect(out.venue).toEqual({ id: String(venue._id), name: 'Rooftop', currency: 'ZAR', status: 'active', activatedAt: venue.activatedAt });
  });

  it('a non-ObjectId vendor id is simply not a venue — never a CastError', async () => {
    expect(await VenueService.forVendor('admin-vendor-id')).toEqual({ venue: null, eligible: false });
  });
});

describe('VenueService.summariesFor', () => {
  it('maps vendorId -> summary for vendors that have a venue only', async () => {
    const a = await makeVendor();
    const b = await makeVendor();
    await VenueService.activate({ vendorId: String(a._id), name: 'A', currency: 'SZL', activatedBy: 'admin-1' });
    const map = await VenueService.summariesFor([a._id as mongoose.Types.ObjectId, b._id as mongoose.Types.ObjectId]);
    expect(map.get(String(a._id))?.name).toBe('A');
    expect(map.has(String(b._id))).toBe(false);
  });

  it('returns an empty map for no ids without querying', async () => {
    expect((await VenueService.summariesFor([])).size).toBe(0);
  });
});
