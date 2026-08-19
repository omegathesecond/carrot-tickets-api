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

  // A LEGACY organizer cashier: written before eventId was required, so she
  // reads back with no event. The schema's `required` fires on WRITE, not on
  // read, so this row is reachable in any database that predates the change —
  // she has to be inserted through the raw driver to reproduce it, because
  // the model itself would now refuse.
  it('DENIES an organizer cashier whose row carries no event, rather than freeing her', async () => {
    const raw = await mongoose.connection.db!.collection('cashiers').insertOne({
      fullName: 'Legacy', loginCode: '820012', pin: '$2b$10$notarealhashbutfine',
      scope: 'organizer', vendorId: oid(), isActive: true,
      failedPinAttempts: 0, lockedUntil: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const req = { cashier: { scope: 'cashier', cashierId: String(raw.insertedId) } };

    // An EMPTY array, not null — null would mean unrestricted, and
    // loadCashlessEvent does no vendor check of its own, so she would be able
    // to transact at any published cashless event of ANY organizer.
    expect(await resolveOperatorEventScope(req as any)).toEqual([]);
    expect(await operatorMayActOnEvent(req as any, oid().toString())).toBe(false);
  });

  // The state cleanup-eventless-cashiers.ts manufactures. Seeded and then
  // DELETED rather than merely fabricating an unknown id, so the test walks
  // the exact path a real cleanup run produces.
  it('DENIES a cashier whose row has been deleted, whose token still has days to run', async () => {
    const c = await Cashier.create({
      fullName: 'Deleted', loginCode: '820013', pin: '222222',
      scope: 'organizer', vendorId: oid(), eventId: oid(),
    });
    const req = { cashier: { scope: 'cashier', cashierId: (c._id as any).toString() } };
    // Scoped to her own event while she exists…
    expect(await resolveOperatorEventScope(req as any)).toHaveLength(1);

    await Cashier.deleteOne({ _id: c._id });

    // …and DENIED once the row is gone, not freed. authenticateCashier does no
    // DB lookup and tokens last 7 days, so her token keeps authenticating —
    // resolving to null here would hand her every event instead of none.
    expect(await resolveOperatorEventScope(req as any)).toEqual([]);
    expect(await operatorMayActOnEvent(req as any, oid().toString())).toBe(false);
  });

  // Deactivation is the dashboard's only revocation control for a cashier
  // (PATCH /cashiers/:id {isActive:false}). authenticateCashier does no DB
  // lookup and CashierAuthService mints 7-day tokens, so without this the
  // switch would only stop her NEXT LOGIN — the token in her hand would keep
  // topping up and cashing out at the desk for the rest of the week.
  it('DENIES a DEACTIVATED cashier, whose token still has days to run', async () => {
    const hers = oid();
    const c = await Cashier.create({
      fullName: 'Revoked', loginCode: '820014', pin: '222222',
      scope: 'organizer', vendorId: oid(), eventId: hers,
    });
    const req = { cashier: { scope: 'cashier', cashierId: (c._id as any).toString() } };
    // Scoped to her own event while she is active…
    expect(await resolveOperatorEventScope(req as any)).toEqual([hers.toString()]);
    expect(await operatorMayActOnEvent(req as any, hers.toString())).toBe(true);

    await Cashier.updateOne({ _id: c._id }, { $set: { isActive: false } });

    // …and denied everywhere the moment she is deactivated. An EMPTY array,
    // not null — null would mean unrestricted, i.e. the exact opposite.
    expect(await resolveOperatorEventScope(req as any)).toEqual([]);
    expect(await operatorMayActOnEvent(req as any, hers.toString())).toBe(false);
  });

  // The check has to sit BEFORE the platform branch: platform scope returns
  // null (legitimately global), so checking isActive after it would hand a
  // revoked Carrot staffer every cashless event instead of none.
  it('DENIES a deactivated PLATFORM cashier rather than handing her every event', async () => {
    const c = await Cashier.create({
      fullName: 'Revoked Staff', loginCode: '820015', pin: '222222',
      scope: 'platform', isActive: false,
    });
    const req = { cashier: { scope: 'cashier', cashierId: (c._id as any).toString() } };

    expect(await resolveOperatorEventScope(req as any)).toEqual([]);
    expect(await operatorMayActOnEvent(req as any, oid().toString())).toBe(false);
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
