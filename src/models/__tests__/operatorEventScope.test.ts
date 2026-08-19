// api/src/models/__tests__/operatorEventScope.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { Cashier } from '@models/cashier.model';
import { ResellerOperator } from '@models/resellerOperator.model';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const vendorId = () => new mongoose.Types.ObjectId();

const newGate = (over: Record<string, unknown> = {}) =>
  GateOperator.create({ fullName: 'Gate', loginCode: '810001', pin: '111111', scope: 'organizer', vendorId: vendorId(), ...over });

const newCashier = (over: Record<string, unknown> = {}) =>
  Cashier.create({ fullName: 'Desk', loginCode: '810002', pin: '222222', scope: 'organizer', vendorId: vendorId(), ...over });

const newResellerOperator = (over: Record<string, unknown> = {}) =>
  ResellerOperator.create({
    fullName: 'Outlet', loginCode: '810003', pin: '333333', role: 'reseller_operator',
    hubId: new mongoose.Types.ObjectId(), resellerId: new mongoose.Types.ObjectId(), ...over,
  });

describe('eventIds defaults to an empty set (= every event)', () => {
  it('on a gate operator', async () => {
    expect((await newGate()).eventIds).toEqual([]);
  });

  it('on a reseller operator', async () => {
    expect((await newResellerOperator()).eventIds).toEqual([]);
  });
});

// A cashier deliberately does NOT use the shared mixin — she is hired for one
// event and carries a singular, immutable `eventId` (see
// cashier.eventScope.test.ts). Asserted here so re-applying
// applyOperatorEventScope to Cashier — which would hand every cashier the
// "empty = every event" default and silently unscope her — fails loudly.
it('a cashier carries no eventIds set at all', async () => {
  const cashier = await newCashier({ eventId: new mongoose.Types.ObjectId() });

  expect((cashier as unknown as { eventIds?: unknown }).eventIds).toBeUndefined();
  expect(cashier.eventId).toBeDefined();
});

describe('eventIds round-trips an assignment', () => {
  it('stores several events and reads them back as ObjectIds', async () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();

    const created = await newGate({ eventIds: [a, b] });
    const reloaded = await GateOperator.findById(created._id);

    expect(reloaded!.eventIds.map(String)).toEqual([a.toString(), b.toString()]);
  });

  it('is serialized to JSON (it is assignment metadata, not a secret like the pin)', async () => {
    const a = new mongoose.Types.ObjectId();
    const serialized = JSON.parse(JSON.stringify(await newResellerOperator({ eventIds: [a] })));

    expect(serialized.eventIds).toEqual([a.toString()]);
    expect(serialized.pin).toBeUndefined();
  });
});

it('rejects a non-ObjectId event assignment rather than silently dropping it', async () => {
  await expect(newGate({ eventIds: ['not-an-event-id'] })).rejects.toThrow();
});
