import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedVendorSessionToken } from '@/__tests__/helpers/auth';
import { seedVenue, seedVenueWaiter, venueDashboardAuth } from '@/__tests__/helpers/venueFloor';
import { Venue } from '@models/venue.model';
import { Waiter } from '@models/waiter.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const URL = '/api/tickets/venue/waiters';
const eventWaiterOf = (vendorId: string) => Waiter.create({
  fullName: 'Event Thabo', loginCode: 'EVW001', pin: '123456', scope: 'organizer', vendorId, eventId: new mongoose.Types.ObjectId(),
});

describe('venue waiters (dashboard)', () => {
  it('hires a waiter who can take payment, and they can sign in', async () => {
    const venue = await seedVenue({ name: 'Kwa-Linda Lounge' });
    const res = await request(app).post(URL).set('Authorization', await venueDashboardAuth(venue)).send({ fullName: 'Sipho', phoneNumber: '+26876000001' });
    expect(res.status).toBe(201);
    expect(res.body.data.loginCode).toMatch(/^[0-9A-Z]{6}$/);
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    expect(res.body.data.waiter.grants).toEqual(['settle_tables']);
    const stored = await Waiter.findById(res.body.data.waiter._id).lean();
    expect(String(stored?.venueId)).toBe(venue.venueId);
    expect(String(stored?.vendorId)).toBe(venue.vendorId);
    expect(stored?.eventId).toBeUndefined();
    const login = await request(app).post('/api/operator/login').send({ loginCode: res.body.data.loginCode, pin: res.body.data.pin });
    expect(login.status).toBe(200);
    expect(login.body.data.operator).toMatchObject({ venueId: venue.venueId, venueName: 'Kwa-Linda Lounge' });
  });

  it('can hire one who only serves', async () => {
    const venue = await seedVenue();
    const res = await request(app).post(URL).set('Authorization', await venueDashboardAuth(venue)).send({ fullName: 'Lindiwe', grants: [] });
    expect(res.status).toBe(201);
    expect(res.body.data.waiter.grants).toEqual([]);
  });

  it('requires a name', async () => {
    const res = await request(app).post(URL).set('Authorization', await venueDashboardAuth(await seedVenue())).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('fullName is required');
  });

  it("lists this venue's waiters only", async () => {
    const venue = await seedVenue();
    const mine = await seedVenueWaiter(venue, { fullName: 'Sipho' });
    await seedVenueWaiter(await seedVenue(), { fullName: 'Other Venue' });
    await eventWaiterOf(venue.vendorId);
    const res = await request(app).get(URL).set('Authorization', await venueDashboardAuth(venue));
    expect(res.status).toBe(200);
    expect(res.body.data.map((w: { _id: string }) => w._id)).toEqual([mine.waiterId]);
  });

  it('the event waiter list never shows a venue waiter', async () => {
    const venue = await seedVenue();
    await seedVenueWaiter(venue, { fullName: 'Venue Sipho' });
    const eventWaiter = await eventWaiterOf(venue.vendorId);
    const auth = `Bearer ${await seedVendorSessionToken(venue.vendorId, { permissions: [TicketsPermission.MANAGE_ACCESS] })}`;
    const res = await request(app).get('/api/tickets/waiters').set('Authorization', auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((w: { _id: string }) => w._id)).toEqual([String(eventWaiter._id)]);
  });

  it('switches taking payment off and on, and deactivates', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    const auth = await venueDashboardAuth(venue);
    const off = await request(app).patch(`${URL}/${w.waiterId}`).set('Authorization', auth).send({ grants: [] });
    expect(off.status).toBe(200);
    expect(off.body.data.grants).toEqual([]);
    const on = await request(app).patch(`${URL}/${w.waiterId}`).set('Authorization', auth).send({ grants: ['settle_tables'], isActive: false });
    expect(on.body.data.grants).toEqual(['settle_tables']);
    expect(on.body.data.isActive).toBe(false);
  });

  it('resets a PIN', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    const res = await request(app).post(`${URL}/${w.waiterId}/reset-pin`).set('Authorization', await venueDashboardAuth(venue)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ waiterId: w.waiterId });
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    const login = await request(app).post('/api/operator/login').send({ loginCode: w.loginCode, pin: res.body.data.pin });
    expect(login.status).toBe(200);
  });

  it("answers 404 for another venue's waiter, an event waiter and a junk id", async () => {
    const venue = await seedVenue();
    const auth = await venueDashboardAuth(venue);
    const other = await seedVenueWaiter(await seedVenue());
    const eventWaiter = await eventWaiterOf(venue.vendorId);
    for (const id of [other.waiterId, String(eventWaiter._id), 'junk']) {
      const patch = await request(app).patch(`${URL}/${id}`).set('Authorization', auth).send({ isActive: false });
      expect(patch.status).toBe(404);
      const reset = await request(app).post(`${URL}/${id}/reset-pin`).set('Authorization', auth).send({});
      expect(reset.status).toBe(404);
    }
    expect((await Waiter.findById(other.waiterId))!.isActive).toBe(true);
    expect((await Waiter.findById(eventWaiter._id))!.isActive).toBe(true);
  });

  it('an event route cannot touch a venue waiter', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    const auth = `Bearer ${await seedVendorSessionToken(venue.vendorId, { permissions: [TicketsPermission.MANAGE_ACCESS] })}`;
    const res = await request(app).patch(`/api/tickets/waiters/${w.waiterId}`).set('Authorization', auth).send({ isActive: false });
    expect(res.status).toBe(404);
    expect((await Waiter.findById(w.waiterId))!.isActive).toBe(true);
  });

  it('needs tickets:manage_venue; no venue is 404; a suspended venue is 403', async () => {
    const venue = await seedVenue();
    const stockOnly = await request(app).get(URL).set('Authorization', await venueDashboardAuth(venue, [TicketsPermission.MANAGE_STOCK, TicketsPermission.VIEW_REVENUE]));
    expect(stockOnly.status).toBe(403);
    const noVenue = await request(app).get(URL).set('Authorization', `Bearer ${await seedVendorSessionToken(String(new mongoose.Types.ObjectId()), { permissions: [TicketsPermission.MANAGE_VENUE] })}`);
    expect(noVenue.status).toBe(404);
    expect(noVenue.body.message).toBe('No venue on this account');
    await Venue.updateOne({ _id: venue.venueId }, { $set: { status: 'suspended' } });
    const suspended = await request(app).get(URL).set('Authorization', await venueDashboardAuth(venue));
    expect(suspended.status).toBe(403);
    expect(suspended.body.message).toBe('Venue trading is suspended');
  });
});
