// api/src/routes/__tests__/resellerEventAssignmentAdmin.route.test.ts
//
// Super-admin assigns events to a reseller. The assignment is the reseller's
// whole world, so a bad id must 400 rather than quietly persist an event that
// does not exist and lock the partner out of everything.
import request from 'supertest';
import app from '@/app';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { signSuperAdminToken } from '../../__tests__/helpers/auth';
import { seedReseller, seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Reseller } from '@models/reseller.model';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

const patch = (resellerId: string, body: Record<string, unknown>) =>
  request(app)
    .patch(`/api/admin/resellers/${resellerId}`)
    .set('Authorization', `Bearer ${signSuperAdminToken()}`)
    .send(body);

it('assigns events to a reseller and reads them back', async () => {
  const { resellerId } = await seedReseller();
  const a = await seedPublishedEvent();
  const b = await seedPublishedEvent();

  const res = await patch(resellerId, { eventIds: [a.eventId, b.eventId] });

  expect(res.status).toBe(200);
  expect(res.body.data.eventIds.map(String).sort()).toEqual([a.eventId, b.eventId].sort());

  const stored = await Reseller.findById(resellerId);
  expect(stored!.eventIds.map(String).sort()).toEqual([a.eventId, b.eventId].sort());
});

it('clears an assignment back to every event with an empty array', async () => {
  const { resellerId } = await seedReseller();
  const a = await seedPublishedEvent();
  await patch(resellerId, { eventIds: [a.eventId] });

  const res = await patch(resellerId, { eventIds: [] });

  expect(res.status).toBe(200);
  expect((await Reseller.findById(resellerId))!.eventIds).toEqual([]);
});

it('leaves an existing assignment untouched when eventIds is not sent', async () => {
  const { resellerId } = await seedReseller();
  const a = await seedPublishedEvent();
  await patch(resellerId, { eventIds: [a.eventId] });

  const res = await patch(resellerId, { commissionPercent: 7 });

  expect(res.status).toBe(200);
  expect((await Reseller.findById(resellerId))!.eventIds.map(String)).toEqual([a.eventId]);
});

it('rejects an event that does not exist', async () => {
  const { resellerId } = await seedReseller();
  const ghost = new mongoose.Types.ObjectId().toString();

  const res = await patch(resellerId, { eventIds: [ghost] });

  expect(res.status).toBe(400);
  expect((await Reseller.findById(resellerId))!.eventIds).toEqual([]);
});

it('rejects a malformed event id', async () => {
  const { resellerId } = await seedReseller();

  const res = await patch(resellerId, { eventIds: ['not-an-id'] });

  expect(res.status).toBe(400);
});

it('rejects an eventIds that is not an array', async () => {
  const { resellerId } = await seedReseller();

  const res = await patch(resellerId, { eventIds: 'all of them' });

  expect(res.status).toBe(400);
});

it('de-duplicates a repeated event rather than storing it twice', async () => {
  const { resellerId } = await seedReseller();
  const a = await seedPublishedEvent();

  const res = await patch(resellerId, { eventIds: [a.eventId, a.eventId] });

  expect(res.status).toBe(200);
  expect((await Reseller.findById(resellerId))!.eventIds.map(String)).toEqual([a.eventId]);
});

it('refuses a request with no super-admin token', async () => {
  const { resellerId } = await seedReseller();
  const a = await seedPublishedEvent();

  const res = await request(app)
    .patch(`/api/admin/resellers/${resellerId}`)
    .send({ eventIds: [a.eventId] });

  expect(res.status).toBe(401);
});
