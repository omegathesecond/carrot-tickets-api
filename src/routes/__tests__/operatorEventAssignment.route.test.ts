// api/src/routes/__tests__/operatorEventAssignment.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { GateOperator } from '@models/gateOperator.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR_A = '64b000000000000000000a01';
const VENDOR_B = '64b000000000000000000b02';

function token(opts: { isSuperAdmin?: boolean; vendorId?: string }) {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:manage_access'], isSuperAdmin: !!opts.isSuperAdmin, vendorId: opts.vendorId,
  }, JWT_SECRET);
}

async function eventFor(vendorId: string, name = 'Show') {
  const future = new Date(Date.now() + 7 * 864e5);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId), name, venue: 'V',
    eventDate: future, startTime: future, endTime: future, status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// This is the contract for the MULTI-event operator populations. Cashiers
// used to be asserted here too, but a cashier is now hired for exactly ONE
// event and has her own, deliberately different contract — see
// cashierAdmin.route.test.ts. Kept as a table so the remaining multi-event
// populations can be added back without restructuring.
const POPULATIONS = [
  { label: 'gate operator', path: '/api/tickets/gate-operators', model: GateOperator, key: 'operator' },
] as const;

describe.each(POPULATIONS)('$label event assignment', ({ path, model, key }) => {
  it('an organizer attaches their own events at create time', async () => {
    const event = await eventFor(VENDOR_A, 'Assigned Show');

    const res = await request(app).post(path)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Staffer', eventIds: [(event._id as any).toString()] });

    expect(res.status).toBe(201);
    expect(res.body.data[key].eventIds).toEqual([(event._id as any).toString()]);
  });

  it('defaults to an unrestricted operator when no events are named', async () => {
    const res = await request(app).post(path)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Staffer' });

    expect(res.status).toBe(201);
    expect(res.body.data[key].eventIds).toEqual([]);
  });

  it("refuses to attach another organizer's event", async () => {
    const foreign = await eventFor(VENDOR_B, 'Someone Elses Show');

    const res = await request(app).post(path)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Staffer', eventIds: [(foreign._id as any).toString()] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/event/i);
  });

  it('refuses an event id that does not exist', async () => {
    const res = await request(app).post(path)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Staffer', eventIds: [new mongoose.Types.ObjectId().toString()] });

    expect(res.status).toBe(400);
  });

  it('reassigns events on an existing operator', async () => {
    const first = await eventFor(VENDOR_A, 'First');
    const second = await eventFor(VENDOR_A, 'Second');
    const created = await (model as any).create({
      fullName: 'Staffer', loginCode: '830001', pin: '111111',
      scope: 'organizer', vendorId: VENDOR_A, eventIds: [first._id],
    });

    const res = await request(app).patch(`${path}/${created._id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ eventIds: [(second._id as any).toString()] });

    expect(res.status).toBe(200);
    expect(res.body.data.eventIds).toEqual([(second._id as any).toString()]);
  });

  it('clears an assignment back to all-events with an empty array', async () => {
    const event = await eventFor(VENDOR_A);
    const created = await (model as any).create({
      fullName: 'Staffer', loginCode: '830002', pin: '111111',
      scope: 'organizer', vendorId: VENDOR_A, eventIds: [event._id],
    });

    const res = await request(app).patch(`${path}/${created._id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ eventIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.data.eventIds).toEqual([]);
  });

  it("refuses to reassign onto another organizer's event", async () => {
    const foreign = await eventFor(VENDOR_B);
    const created = await (model as any).create({
      fullName: 'Staffer', loginCode: '830003', pin: '111111', scope: 'organizer', vendorId: VENDOR_A,
    });

    const res = await request(app).patch(`${path}/${created._id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ eventIds: [(foreign._id as any).toString()] });

    expect(res.status).toBe(400);
  });

  it('leaves the assignment untouched when a PATCH does not mention it', async () => {
    const event = await eventFor(VENDOR_A);
    const created = await (model as any).create({
      fullName: 'Staffer', loginCode: '830004', pin: '111111',
      scope: 'organizer', vendorId: VENDOR_A, eventIds: [event._id],
    });

    const res = await request(app).patch(`${path}/${created._id}`)
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`)
      .send({ fullName: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data.eventIds).toEqual([(event._id as any).toString()]);
  });

  it('checks a super-admin assignment against the vendor they are creating for, not their own', async () => {
    const foreign = await eventFor(VENDOR_B, 'Vendor B Show');

    const ok = await request(app).post(path)
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Staffer', scope: 'organizer', vendorId: VENDOR_B, eventIds: [(foreign._id as any).toString()] });
    expect(ok.status).toBe(201);

    const mismatched = await request(app).post(path)
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`)
      .send({ fullName: 'Staffer2', scope: 'organizer', vendorId: VENDOR_A, eventIds: [(foreign._id as any).toString()] });
    expect(mismatched.status).toBe(400);
  });
});
