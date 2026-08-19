// api/src/services/__tests__/operatorEventScope.service.test.ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { Cashier } from '@models/cashier.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { resolveOperatorEventScope, operatorMayActOnEvent } from '@services/operatorEventScope.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const oid = () => new mongoose.Types.ObjectId();

describe('actors that are never event-restricted resolve to null', () => {
  it('an organizer signing into their own dashboard', async () => {
    const req = { ticketsUser: { userType: 'vendor', userId: oid().toString(), vendorId: oid().toString() } };
    expect(await resolveOperatorEventScope(req as any)).toBeNull();
  });

  it('platform staff', async () => {
    const req = { ticketsUser: { userType: 'vendor', userId: oid().toString(), isSuperAdmin: true } };
    expect(await resolveOperatorEventScope(req as any)).toBeNull();
  });

  it('an unauthenticated request', async () => {
    expect(await resolveOperatorEventScope({} as any)).toBeNull();
  });

  it('a reseller OWNER token, whose operatorId is really their reseller id', async () => {
    const resellerId = oid().toString();
    const req = { reseller: { scope: 'reseller', resellerId, operatorId: resellerId, hubId: null } };
    expect(await resolveOperatorEventScope(req as any)).toBeNull();
  });
});

describe('an operator with no assignment is unrestricted (empty = every event)', () => {
  it('gate operator', async () => {
    const op = await GateOperator.create({ fullName: 'G', loginCode: '820001', pin: '111111', scope: 'organizer', vendorId: oid() });
    const req = { ticketsUser: { userType: 'gate-operator', userId: (op._id as any).toString() } };
    expect(await resolveOperatorEventScope(req as any)).toBeNull();
  });

  // An ORGANIZER cashier can no longer exist without an event (the schema
  // requires one), so the only unrestricted cashier is a PLATFORM one —
  // Carrot's own staff, legitimately global.
  it('platform cashier', async () => {
    const c = await Cashier.create({ fullName: 'C', loginCode: '820002', pin: '222222', scope: 'platform' });
    const req = { cashier: { scope: 'cashier', cashierId: (c._id as any).toString() } };
    expect(await resolveOperatorEventScope(req as any)).toBeNull();
  });

  it('reseller operator', async () => {
    const resellerId = oid();
    const op = await ResellerOperator.create({ fullName: 'R', loginCode: '820003', pin: '333333', role: 'reseller_operator', hubId: oid(), resellerId });
    const req = { reseller: { scope: 'reseller', resellerId: resellerId.toString(), operatorId: (op._id as any).toString() } };
    expect(await resolveOperatorEventScope(req as any)).toBeNull();
  });
});

describe('an assigned operator resolves to exactly their events', () => {
  it('gate operator', async () => {
    const a = oid(), b = oid();
    const op = await GateOperator.create({ fullName: 'G', loginCode: '820004', pin: '111111', scope: 'organizer', vendorId: oid(), eventIds: [a, b] });
    const req = { ticketsUser: { userType: 'gate-operator', userId: (op._id as any).toString() } };

    expect(await resolveOperatorEventScope(req as any)).toEqual([a.toString(), b.toString()]);
  });

  // The cashier's assignment lives in the SINGULAR eventId, not the shared
  // eventIds set. Reading eventIds here would find nothing and resolve to
  // null — i.e. every cashier silently unrestricted — so this is the case
  // that proves the scope resolver reads the right field.
  it('cashier, off her singular eventId', async () => {
    const a = oid();
    const c = await Cashier.create({ fullName: 'C', loginCode: '820005', pin: '222222', scope: 'organizer', vendorId: oid(), eventId: a });
    const req = { cashier: { scope: 'cashier', cashierId: (c._id as any).toString() } };

    expect(await resolveOperatorEventScope(req as any)).toEqual([a.toString()]);
  });

  it('reseller operator', async () => {
    const a = oid();
    const resellerId = oid();
    const op = await ResellerOperator.create({ fullName: 'R', loginCode: '820006', pin: '333333', role: 'reseller_operator', hubId: oid(), resellerId, eventIds: [a] });
    const req = { reseller: { scope: 'reseller', resellerId: resellerId.toString(), operatorId: (op._id as any).toString() } };

    expect(await resolveOperatorEventScope(req as any)).toEqual([a.toString()]);
  });

  it('a token naming an operator that no longer exists is unrestricted, not blocked', async () => {
    const req = { ticketsUser: { userType: 'gate-operator', userId: oid().toString() } };
    expect(await resolveOperatorEventScope(req as any)).toBeNull();
  });
});

describe('operatorMayActOnEvent', () => {
  it('allows an assigned event and refuses every other one', async () => {
    const assigned = oid(), other = oid();
    const op = await GateOperator.create({ fullName: 'G', loginCode: '820007', pin: '111111', scope: 'organizer', vendorId: oid(), eventIds: [assigned] });
    const req = { ticketsUser: { userType: 'gate-operator', userId: (op._id as any).toString() } };

    expect(await operatorMayActOnEvent(req as any, assigned.toString())).toBe(true);
    expect(await operatorMayActOnEvent(req as any, other.toString())).toBe(false);
  });

  it('allows any event for an unassigned operator', async () => {
    const op = await GateOperator.create({ fullName: 'G', loginCode: '820008', pin: '111111', scope: 'organizer', vendorId: oid() });
    const req = { ticketsUser: { userType: 'gate-operator', userId: (op._id as any).toString() } };

    expect(await operatorMayActOnEvent(req as any, oid().toString())).toBe(true);
  });

  it('holds a cashier to her own event and refuses every other one', async () => {
    const hers = oid(), someoneElses = oid();
    const c = await Cashier.create({ fullName: 'C', loginCode: '820010', pin: '222222', scope: 'organizer', vendorId: oid(), eventId: hers });
    const req = { cashier: { scope: 'cashier', cashierId: (c._id as any).toString() } };

    expect(await operatorMayActOnEvent(req as any, hers.toString())).toBe(true);
    // The refusal is the whole point: a cashier hired for one show must not
    // be able to take money at another organizer's gate.
    expect(await operatorMayActOnEvent(req as any, someoneElses.toString())).toBe(false);
    // …and neither may she act with no event named at all.
    expect(await operatorMayActOnEvent(req as any, undefined)).toBe(false);
  });

  it('lets a PLATFORM cashier work any event', async () => {
    const c = await Cashier.create({ fullName: 'Carrot Staff', loginCode: '820011', pin: '222222', scope: 'platform' });
    const req = { cashier: { scope: 'cashier', cashierId: (c._id as any).toString() } };

    expect(await operatorMayActOnEvent(req as any, oid().toString())).toBe(true);
  });

  it('refuses a restricted operator acting with no event at all', async () => {
    const op = await GateOperator.create({ fullName: 'G', loginCode: '820009', pin: '111111', scope: 'organizer', vendorId: oid(), eventIds: [oid()] });
    const req = { ticketsUser: { userType: 'gate-operator', userId: (op._id as any).toString() } };

    expect(await operatorMayActOnEvent(req as any, undefined)).toBe(false);
  });
});
