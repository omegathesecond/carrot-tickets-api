// api/src/models/__tests__/operatorEventScope.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { Reseller } from '@models/reseller.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const vendorId = () => new mongoose.Types.ObjectId();

const newGate = (over: Record<string, unknown> = {}) =>
  GateOperator.create({ fullName: 'Gate', loginCode: '810001', pin: '111111', scope: 'organizer', vendorId: vendorId(), ...over });

const newResellerOperator = (over: Record<string, unknown> = {}) =>
  ResellerOperator.create({
    fullName: 'Outlet', loginCode: '810003', pin: '333333', role: 'reseller_operator',
    hubId: new mongoose.Types.ObjectId(), resellerId: new mongoose.Types.ObjectId(), ...over,
  });

const newReseller = (over: Record<string, unknown> = {}) =>
  Reseller.create({ businessName: 'DeltaPay', commissionPercent: null, ...over });

describe('eventIds defaults to an empty set (= every event)', () => {
  it('on a gate operator', async () => {
    expect((await newGate()).eventIds).toEqual([]);
  });

  it('on a reseller operator', async () => {
    expect((await newResellerOperator()).eventIds).toEqual([]);
  });

  it('on the reseller itself', async () => {
    expect((await newReseller()).eventIds).toEqual([]);
  });
});

describe('eventIds round-trips an assignment', () => {
  it('stores several events on a reseller and reads them back as ObjectIds', async () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();

    const created = await newReseller({ eventIds: [a, b] });
    const reloaded = await Reseller.findById(created._id);

    expect(reloaded!.eventIds.map(String)).toEqual([a.toString(), b.toString()]);
  });

  it('is serialized to JSON (assignment metadata, not a secret like the pin)', async () => {
    const a = new mongoose.Types.ObjectId();
    const serialized = JSON.parse(JSON.stringify(await newResellerOperator({ eventIds: [a] })));

    expect(serialized.eventIds).toEqual([a.toString()]);
    expect(serialized.pin).toBeUndefined();
  });

  it('keeps the reseller password out of JSON while exposing eventIds', async () => {
    const a = new mongoose.Types.ObjectId();
    const serialized = JSON.parse(JSON.stringify(await newReseller({ eventIds: [a], password: 'DeltaPay@2026' })));

    expect(serialized.eventIds).toEqual([a.toString()]);
    expect(serialized.password).toBeUndefined();
  });
});

it('rejects a non-ObjectId event assignment rather than silently dropping it', async () => {
  await expect(newReseller({ eventIds: ['not-an-event-id'] })).rejects.toThrow();
});
