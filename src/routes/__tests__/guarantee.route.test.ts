import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import router from '../guarantee.route';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { EventFinancialsService } from '@services/eventFinancials.service';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { Guarantee } from '@models/guarantee.model';
import { Notification } from '@models/notification.model';
import { NotificationService } from '@services/notification.service';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
const app = express(); app.use(express.json()); app.use('/guarantees', router);
app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ message: err.message }));
const owner = new mongoose.Types.ObjectId();
const provider = new mongoose.Types.ObjectId();
const stranger = new mongoose.Types.ObjectId();
let eventId: string;
const auth = (token = 'owner') => ({ Authorization: `Bearer ${token}` });
const input = () => ({ providerId: String(provider), amount: 40, description: 'Sound equipment', expectedPaymentDate: '2026-11-03' });
const submit = (body = input()) => request(app).post(`/guarantees/events/${eventId}`).set(auth()).send(body);
const response = (id: string, status: string, token: string) => request(app).post(`/guarantees/${id}/response`).set(auth(token)).send({ status, note: 'Recorded note' });
const decision = (id: string, status: string, token = 'admin') => request(app).post(`/guarantees/${id}/status`).set(auth(token)).send({ status, note: 'Admin review' });
beforeAll(async () => {
  await connectLedgerTestDb();
  jest.spyOn(TicketsAuthService, 'verifyAndResolveSession').mockImplementation(async token => ({ vendorId: String(token === 'provider' ? provider : token === 'other' ? stranger : owner), userId: String(stranger), userType: token === 'staff' ? 'sub-user' : 'vendor', isSuperAdmin: token === 'admin', permissions: [] }) as any);
  jest.spyOn(EventFinancialsService, 'getEventFinancials').mockResolvedValue({ custody: { availableNow: 100 } } as any);
}, 60000);
afterAll(async () => { jest.restoreAllMocks(); await disconnectTestDb(); });
beforeEach(async () => {
  await clearTestDb();
  await Vendor.collection.insertMany([{ _id: owner, businessName: 'Organizer', slug: 'organizer', operatorType: 'events', isActive: true }, { _id: provider, businessName: 'Sound provider', slug: 'provider', operatorType: 'services', isActive: true }]);
  const event = await Event.create({ vendorId: owner, name: 'Festival', venue: 'Grounds', eventDate: new Date('2026-12-01'), startTime: new Date('2026-12-01'), endTime: new Date('2026-12-02'), currency: 'SZL' });
  eventId = String(event._id);
});
it('tracks the complete review workflow and durable notifications without changing the balance', async () => {
  const created = await submit(); expect(created.status).toBe(201);
  const id = created.body.data._id;
  expect(await Notification.countDocuments({ type: 'guarantee_status' })).toBe(2);
  expect((await request(app).get('/guarantees/admin').set(auth('admin'))).body.data).toHaveLength(0);
  expect((await response(id, 'accepted', 'provider')).status).toBe(200);
  expect((await request(app).get('/guarantees/admin').set(auth('admin'))).body.data).toHaveLength(1);
  expect((await decision(id, 'pending')).status).toBe(200);
  expect((await decision(id, 'paid')).status).toBe(200);
  expect((await decision(id, 'rejected')).status).toBe(409);
  const row = await Guarantee.findById(id);
  expect(row?.history.map(h => h.status)).toEqual(['requested', 'accepted', 'pending', 'paid']);
  expect(row?.history[3]?.by).toBe(String(stranger));
  expect(row?.history[3]?.at).toBeInstanceOf(Date);
  expect(await Notification.countDocuments({ type: 'guarantee_status' })).toBe(8);
  expect((await EventFinancialsService.getEventFinancials(eventId, String(owner))).custody.availableNow).toBe(100);
});
it('enforces current Financials balance, precision and positive amount', async () => {
  for (const amount of [101, -1, 0, 1.001]) expect((await submit({ ...input(), amount })).status).toBe(400);
  expect((await submit({ ...input(), amount: 100 })).status).toBe(201);
});
it('fails loudly when Financials fails and creates no request', async () => {
  jest.mocked(EventFinancialsService.getEventFinancials).mockRejectedValueOnce(new Error('Financials offline'));
  const result = await submit(); expect(result.status).toBe(500); expect(result.body.message).toBe('Financials offline');
  expect(await Guarantee.countDocuments()).toBe(0);
});
it('restricts owner, provider, and admin actions', async () => {
  expect((await request(app).post(`/guarantees/events/${eventId}`).set(auth('other')).send(input())).status).toBe(404);
  expect((await request(app).post(`/guarantees/events/${eventId}`).set(auth('staff')).send(input())).status).toBe(403);
  const id = (await submit()).body.data._id;
  expect((await response(id, 'accepted', 'owner')).status).toBe(403);
  expect((await decision(id, 'paid', 'owner')).status).toBe(403);
  expect((await decision(id, 'paid')).status).toBe(409);
  expect((await request(app).get('/guarantees/provider').set(auth('other'))).body.data).toHaveLength(0);
});
it('allows editing and withdrawal before a response only', async () => {
  const id = (await submit()).body.data._id;
  const url = `/guarantees/events/${eventId}/${id}`;
  expect((await request(app).put(url).set(auth()).send({ ...input(), amount: 30 })).status).toBe(200);
  expect((await response(id, 'withdrawn', 'owner')).status).toBe(200);
  expect((await response(id, 'accepted', 'provider')).status).toBe(409);
  expect((await request(app).put(url).set(auth()).send(input())).status).toBe(409);
});
it('locks edits and withdrawal after provider rejection', async () => {
  const id = (await submit()).body.data._id;
  expect((await response(id, 'provider_rejected', 'provider')).status).toBe(200);
  expect((await response(id, 'withdrawn', 'owner')).status).toBe(409);
  expect((await decision(id, 'pending')).status).toBe(409);
});
it('keeps agreements private and out of list payloads', async () => {
  const id = (await submit()).body.data._id;
  const url = `/guarantees/${id}/agreement`;
  const data = Buffer.from('%PDF-1.4\nsigned agreement');
  expect((await request(app).post(url).set(auth()).attach('agreement', data, { filename: 'signed.pdf', contentType: 'application/pdf' })).status).toBe(200);
  for (const token of ['owner', 'provider', 'admin']) expect((await request(app).get(url).set(auth(token))).status).toBe(200);
  expect((await request(app).get(url).set(auth('other'))).status).toBe(404);
  expect((await request(app).get(url).set(auth('staff'))).status).toBe(403);
  expect((await request(app).get(`/guarantees/events/${eventId}`).set(auth())).body.data[0].agreement).toBeUndefined();
  expect((await response(id, 'accepted', 'provider')).status).toBe(200);
  expect((await request(app).post(url).set(auth()).attach('agreement', data, 'new.pdf')).status).toBe(409);
});
it('rolls back a transition if notifications fail', async () => {
  const id = (await submit()).body.data._id;
  const spy = jest.spyOn(NotificationService, 'create').mockRejectedValueOnce(new Error('Inbox unavailable'));
  expect((await response(id, 'accepted', 'provider')).status).toBe(500);
  expect((await Guarantee.findById(id))?.status).toBe('requested');
  spy.mockRestore();
});
it('resolves simultaneous acceptance and withdrawal to one outcome', async () => {
  const id = (await submit()).body.data._id;
  const results = await Promise.all([response(id, 'accepted', 'provider'), response(id, 'withdrawn', 'owner')]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await Guarantee.findById(id))?.history).toHaveLength(2);
  expect(await Notification.countDocuments({ type: 'guarantee_status' })).toBe(4);
});

it('changing the selected provider revokes the old provider and removes its agreement', async () => {
  const nextProvider = new mongoose.Types.ObjectId();
  await Vendor.collection.insertOne({ _id: nextProvider, businessName: 'New provider', slug: 'new-provider', operatorType: 'services', isActive: true });
  const id = (await submit()).body.data._id;
  const agreement = `/guarantees/${id}/agreement`;
  await request(app).post(agreement).set(auth()).attach('agreement', Buffer.from('%PDF-1.4\nprivate'), { filename: 'signed.pdf', contentType: 'application/pdf' });
  expect((await request(app).put(`/guarantees/events/${eventId}/${id}`).set(auth()).send({ ...input(), providerId: String(nextProvider) })).status).toBe(200);
  expect((await request(app).get(agreement).set(auth('provider'))).status).toBe(404);
  expect((await request(app).get(agreement).set(auth())).status).toBe(404);
  expect((await request(app).get('/guarantees/provider').set(auth('provider'))).body.data).toHaveLength(0);
});
