// api/src/services/__tests__/operatorEventScope.service.test.ts
import { Request } from 'express';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Reseller } from '@models/reseller.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { GateOperator } from '@models/gateOperator.model';
import {
  resolveOperatorEventScope,
  operatorMayActOnEvent,
} from '@services/operatorEventScope.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const oid = () => new mongoose.Types.ObjectId();

/** A reseller OWNER request — the owner token sets operatorId to the reseller's own id. */
const ownerReq = (resellerId: string) =>
  ({ reseller: { resellerId, operatorId: resellerId } }) as unknown as Request;

/** A reseller TILL request — operatorId names a real ResellerOperator row. */
const tillReq = (resellerId: string, operatorId: string) =>
  ({ reseller: { resellerId, operatorId } }) as unknown as Request;

async function seedScopedReseller(eventIds: mongoose.Types.ObjectId[] = []) {
  const r = await Reseller.create({ businessName: 'DeltaPay', commissionPercent: null, eventIds });
  return r._id.toString();
}

async function seedTill(resellerId: string, eventIds: mongoose.Types.ObjectId[] = []) {
  const op = await ResellerOperator.create({
    fullName: 'Till', loginCode: String(900000 + Math.floor(Number(`0x${resellerId.slice(-4)}`) % 90000)),
    pin: '112233', role: 'reseller_operator',
    hubId: oid(), resellerId, eventIds,
  });
  return op._id.toString();
}

describe('a caller with no restriction resolves to null', () => {
  it('when the request carries no reseller at all', async () => {
    expect(await resolveOperatorEventScope({} as Request)).toBeNull();
  });

  it('when the reseller and its till are both unassigned', async () => {
    const resellerId = await seedScopedReseller([]);
    const operatorId = await seedTill(resellerId, []);
    expect(await resolveOperatorEventScope(tillReq(resellerId, operatorId))).toBeNull();
  });
});

describe('the reseller tier binds the owner token', () => {
  it('scopes an owner login to the events the reseller is assigned', async () => {
    const a = oid(), b = oid();
    const resellerId = await seedScopedReseller([a, b]);

    const scope = await resolveOperatorEventScope(ownerReq(resellerId));

    expect(scope!.sort()).toEqual([a.toString(), b.toString()].sort());
  });

  it('leaves an unassigned reseller owner unrestricted', async () => {
    const resellerId = await seedScopedReseller([]);
    expect(await resolveOperatorEventScope(ownerReq(resellerId))).toBeNull();
  });
});

describe('the two tiers intersect', () => {
  it('narrows the till to the events BOTH the reseller and the till hold', async () => {
    const a = oid(), b = oid(), c = oid();
    const resellerId = await seedScopedReseller([a, b]);
    const operatorId = await seedTill(resellerId, [b, c]);

    expect(await resolveOperatorEventScope(tillReq(resellerId, operatorId))).toEqual([b.toString()]);
  });

  it('falls back to the reseller tier for a till with no assignment of its own', async () => {
    const a = oid();
    const resellerId = await seedScopedReseller([a]);
    const operatorId = await seedTill(resellerId, []);

    expect(await resolveOperatorEventScope(tillReq(resellerId, operatorId))).toEqual([a.toString()]);
  });

  it('falls back to the till tier when the reseller is unassigned', async () => {
    const c = oid();
    const resellerId = await seedScopedReseller([]);
    const operatorId = await seedTill(resellerId, [c]);

    expect(await resolveOperatorEventScope(tillReq(resellerId, operatorId))).toEqual([c.toString()]);
  });
});

describe('a disjoint assignment denies every event rather than widening to all', () => {
  it('resolves to an EMPTY set, which is not the same as null', async () => {
    const a = oid(), c = oid();
    const resellerId = await seedScopedReseller([a]);
    const operatorId = await seedTill(resellerId, [c]);

    const scope = await resolveOperatorEventScope(tillReq(resellerId, operatorId));

    expect(scope).toEqual([]);
    expect(scope).not.toBeNull();
  });

  it('so the till may act on neither event', async () => {
    const a = oid(), c = oid();
    const resellerId = await seedScopedReseller([a]);
    const operatorId = await seedTill(resellerId, [c]);
    const req = tillReq(resellerId, operatorId);

    expect(await operatorMayActOnEvent(req, a.toString())).toBe(false);
    expect(await operatorMayActOnEvent(req, c.toString())).toBe(false);
  });
});

describe('a vanished row fails closed', () => {
  it('denies a token whose reseller has been deleted', async () => {
    const resellerId = oid().toString();
    expect(await resolveOperatorEventScope(ownerReq(resellerId))).toEqual([]);
  });

  it('still holds a till to the reseller scope when the till row is gone', async () => {
    const a = oid();
    const resellerId = await seedScopedReseller([a]);

    const scope = await resolveOperatorEventScope(tillReq(resellerId, oid().toString()));

    expect(scope).toEqual([a.toString()]);
  });
});

describe('operatorMayActOnEvent', () => {
  it('allows an unrestricted caller onto any event', async () => {
    const resellerId = await seedScopedReseller([]);
    expect(await operatorMayActOnEvent(ownerReq(resellerId), oid().toString())).toBe(true);
  });

  it('allows an assigned event and refuses an unassigned one', async () => {
    const a = oid(), b = oid();
    const resellerId = await seedScopedReseller([a]);

    expect(await operatorMayActOnEvent(ownerReq(resellerId), a.toString())).toBe(true);
    expect(await operatorMayActOnEvent(ownerReq(resellerId), b.toString())).toBe(false);
  });

  it('refuses a restricted caller who names no event at all', async () => {
    const resellerId = await seedScopedReseller([oid()]);
    expect(await operatorMayActOnEvent(ownerReq(resellerId), undefined)).toBe(false);
  });
});

describe('gate operators keep their own single-tier behaviour', () => {
  it('resolves an assigned gate operator to its events', async () => {
    const a = oid();
    const gate = await GateOperator.create({
      fullName: 'Gate', loginCode: '870001', pin: '445566',
      scope: 'organizer', vendorId: oid(), eventIds: [a],
    });
    const req = { ticketsUser: { userType: 'gate-operator', userId: gate._id.toString() } } as unknown as Request;

    expect(await resolveOperatorEventScope(req)).toEqual([a.toString()]);
  });
});

it('propagates a database failure instead of silently widening access', async () => {
  const resellerId = await seedScopedReseller([oid()]);
  const boom = new Error('replica set unreachable');
  const spy = jest.spyOn(Reseller, 'findById').mockImplementation(() => { throw boom; });

  await expect(resolveOperatorEventScope(ownerReq(resellerId))).rejects.toThrow('replica set unreachable');

  spy.mockRestore();
});
