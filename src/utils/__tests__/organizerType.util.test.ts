import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { OperatorType } from '@interfaces/vendor.interface';
import { ORGANIZER_TYPES, organizerTypeFilter, organizerTypeOf, OrganizerType } from '@utils/organizerType.util';

const id = () => new mongoose.Types.ObjectId();

describe('organizerTypeOf — first matching rule wins', () => {
  const none = new Set<string>();

  it('exposes the four types', () => {
    expect(ORGANIZER_TYPES).toEqual(['events', 'venues', 'services', 'transport']);
  });

  it('services beats everything, even a venue-typed account', () => {
    expect(organizerTypeOf({ _id: id(), operatorType: 'services', businessType: 'venue' }, none)).toBe('services');
  });

  it('services beats a Venue record too', () => {
    const v = id();
    expect(organizerTypeOf({ _id: v, operatorType: 'services' }, new Set([String(v)]))).toBe('services');
  });

  it('businessType venue is a venue', () => {
    expect(organizerTypeOf({ _id: id(), operatorType: 'events', businessType: 'venue' }, none)).toBe('venues');
  });

  it('an events account WITH a Venue record is a venue', () => {
    const v = id();
    expect(organizerTypeOf({ _id: v, operatorType: 'events', businessType: 'other' }, new Set([String(v)]))).toBe('venues');
  });

  it('venues beats transport', () => {
    expect(organizerTypeOf({ _id: id(), operatorType: 'transport', businessType: 'venue' }, none)).toBe('venues');
  });

  it('transport is transport', () => {
    expect(organizerTypeOf({ _id: id(), operatorType: 'transport', businessType: 'other' }, none)).toBe('transport');
  });

  it('a both account is events', () => {
    expect(organizerTypeOf({ _id: id(), operatorType: 'both' }, none)).toBe('events');
  });

  it('a missing operatorType is events', () => {
    expect(organizerTypeOf({ _id: id() }, none)).toBe('events');
    expect(organizerTypeOf({ _id: id(), operatorType: null, businessType: null }, none)).toBe('events');
  });

  it('a Venue record for ANOTHER vendor does not make this one a venue', () => {
    expect(organizerTypeOf({ _id: id(), operatorType: 'events' }, new Set([String(id())]))).toBe('events');
  });
});

describe('organizerTypeFilter rejects a type it does not know', () => {
  it('throws rather than guessing', () => {
    expect(() => organizerTypeFilter('bogus' as OrganizerType, new Set())).toThrow('Unknown organizer type: bogus');
  });
});

describe('organizerTypeFilter agrees with organizerTypeOf (no drift)', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);
  afterEach(clearTestDb);

  // Every combination the rules look at: operatorType (incl. absent) x
  // businessType x whether a Venue record exists.
  // Built from the enum so a new OperatorType is covered automatically.
  const operatorTypes: Array<string | undefined> = [...Object.values(OperatorType), undefined];
  const businessTypes = ['venue', 'other'] as const;

  async function seedMatrix() {
    let n = 0;
    const rows: Array<{ _id: mongoose.Types.ObjectId; operatorType?: string; businessType: string }> = [];
    for (const operatorType of operatorTypes) {
      for (const businessType of businessTypes) {
        for (const hasVenue of [true, false]) {
          n += 1;
          const v = await Vendor.create({
            businessName: `Matrix ${n}`,
            phoneNumber: `+2687610${String(n).padStart(4, '0')}`,
            password: 'secret1',
            businessType,
            ...(operatorType ? { operatorType } : {}),
            ...(operatorType === 'services' ? { serviceCategory: 'catering' } : {}),
          });
          // The model defaults operatorType; a legacy row simply lacks the field.
          if (!operatorType) await Vendor.collection.updateOne({ _id: v._id }, { $unset: { operatorType: '' } });
          if (hasVenue) await Venue.create({ vendorId: v._id, name: `V${n}`, currency: 'SZL', activatedBy: 'admin' });
          rows.push({ _id: v._id, ...(operatorType ? { operatorType } : {}), businessType });
        }
      }
    }
    return rows;
  }

  it('find() and aggregate() return exactly the vendors organizerTypeOf assigns to each type', async () => {
    const rows = await seedMatrix();
    const venueIds = new Set((await Venue.find().select('vendorId').lean()).map((x) => String(x.vendorId)));
    expect(rows).toHaveLength(operatorTypes.length * businessTypes.length * 2);

    const seen = new Set<string>();
    for (const type of ORGANIZER_TYPES as readonly OrganizerType[]) {
      const expected = rows.filter((r) => organizerTypeOf(r, venueIds) === type).map((r) => String(r._id)).sort();
      const filter = organizerTypeFilter(type, venueIds);

      const found = (await Vendor.find(filter).select('_id').lean()).map((r) => String(r._id)).sort();
      expect(found).toEqual(expected);

      const agg = (await Vendor.aggregate([{ $match: filter }, { $project: { _id: 1 } }])).map((r) => String(r._id)).sort();
      expect(agg).toEqual(expected);

      expect(expected.length).toBeGreaterThan(0);
      for (const e of expected) {
        expect(seen.has(e)).toBe(false); // exactly one type per account
        seen.add(e);
      }
    }
    expect(seen.size).toBe(rows.length); // and every account has a type
  });
});
