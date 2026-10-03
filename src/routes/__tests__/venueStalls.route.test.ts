import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, disconnectTestDb, clearTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Venue } from '@models/venue.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const { MANAGE_VENUE, MANAGE_STOCK, MANAGE_ACCESS } = TicketsPermission;
let seq = 0;

async function ownedVenue(opts: { status?: 'active' | 'suspended'; permissions?: string[] } = {}) {
  seq += 1;
  const vendor = await Vendor.create({ businessName: `Lounge ${seq}`, email: `lounge${seq}@x.co`, password: 'secret1', businessType: 'venue' });
  const venue = await Venue.create({ vendorId: vendor._id, name: `Lounge ${seq}`, currency: 'SZL', status: opts.status ?? 'active', activatedBy: 'admin' });
  const token = signVendorToken(String(vendor._id), { permissions: opts.permissions ?? [MANAGE_VENUE, MANAGE_STOCK, MANAGE_ACCESS] });
  return { vendorId: String(vendor._id), venueId: String(venue._id), venueName: venue.name, auth: `Bearer ${token}` };
}
const eventStall = () => Merchant.create({ name: 'Event Bar', eventId: new mongoose.Types.ObjectId(), commissionPercent: 10 });

describe('venue stalls', () => {
  it('creates a stall owned by the venue, always at 0% commission', async () => {
    const v = await ownedVenue();
    const res = await request(app).post('/api/tickets/venue/stalls').set('Authorization', v.auth)
      .send({ name: 'Main Bar', commissionPercent: 15 });
    expect(res.status).toBe(201);
    const stored = await Merchant.findById(res.body.data.merchant._id).lean();
    expect(String(stored?.venueId)).toBe(v.venueId);
    expect(stored?.eventId).toBeUndefined();
    expect(stored?.commissionPercent).toBe(0);
  });

  it("lists only this venue's stalls", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    await Merchant.create({ name: 'A Bar', venueId: a.venueId });
    await Merchant.create({ name: 'B Bar', venueId: b.venueId });
    await eventStall();
    const res = await request(app).get('/api/tickets/venue/stalls').set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { name: string }) => m.name)).toEqual(['A Bar']);
  });

  it("renames its own stall (commission stays 0); another venue's stall and an event stall 404 untouched", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const mine = await Merchant.create({ name: 'Old', venueId: a.venueId });
    const theirs = await Merchant.create({ name: 'Theirs', venueId: b.venueId });
    const ev = await eventStall();
    const ok = await request(app).patch(`/api/tickets/venue/stalls/${mine._id}`).set('Authorization', a.auth)
      .send({ name: 'New', commissionPercent: 20 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.name).toBe('New');
    expect(ok.body.data.commissionPercent).toBe(0);
    for (const target of [theirs, ev]) {
      const res = await request(app).patch(`/api/tickets/venue/stalls/${target._id}`).set('Authorization', a.auth).send({ name: 'Hijack' });
      expect(res.status).toBe(404);
    }
    expect((await Merchant.findById(theirs._id).lean())?.name).toBe('Theirs');
    expect((await Merchant.findById(ev._id).lean())?.name).toBe('Event Bar');
  });

  it('an event route cannot reach a venue stall', async () => {
    const a = await ownedVenue();
    const mine = await Merchant.create({ name: 'Mine', venueId: a.venueId });
    const res = await request(app).patch(`/api/tickets/merchants/${mine._id}`).set('Authorization', a.auth).send({ name: 'x' });
    expect(res.status).toBe(404);
    expect((await Merchant.findById(mine._id).lean())?.name).toBe('Mine');
  });

  it('stall detail returns the stall and its VENUE (no event key)', async () => {
    const a = await ownedVenue();
    const mine = await Merchant.create({ name: 'Mine', venueId: a.venueId });
    const res = await request(app).get(`/api/tickets/venue/stalls/${mine._id}/transactions`).set('Authorization', a.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.merchant.name).toBe('Mine');
    expect(res.body.data.venue).toEqual({ id: a.venueId, name: a.venueName });
    expect(res.body.data.event).toBeUndefined();
  });

  it('a suspended venue gets 403; an account without a venue gets 404', async () => {
    const s = await ownedVenue({ status: 'suspended' });
    const suspended = await request(app).get('/api/tickets/venue/stalls').set('Authorization', s.auth);
    expect(suspended.status).toBe(403);
    expect(suspended.body.message).toBe('Venue trading is suspended');

    const organizer = await Vendor.create({ businessName: 'Gigs', email: 'gigs@x.co', password: 'secret1' });
    const none = await request(app).get('/api/tickets/venue/stalls')
      .set('Authorization', `Bearer ${signVendorToken(String(organizer._id), { permissions: [MANAGE_VENUE] })}`);
    expect(none.status).toBe(404);
    expect(none.body.message).toBe('No venue on this account');
  });

  it('stall writes need tickets:manage_venue; listing also accepts tickets:manage_stock', async () => {
    const v = await ownedVenue({ permissions: [MANAGE_STOCK] });
    expect((await request(app).post('/api/tickets/venue/stalls').set('Authorization', v.auth).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/tickets/venue/stalls').set('Authorization', v.auth)).status).toBe(200);
  });
});

describe('venue till staff', () => {
  it('issues credentials for a venue stall; the operator is owned by the venue', async () => {
    const v = await ownedVenue();
    const stall = await Merchant.create({ name: 'Main Bar', venueId: v.venueId });
    const res = await request(app).post(`/api/tickets/venue/stalls/${stall._id}/operators`).set('Authorization', v.auth)
      .send({ fullName: 'Thabo Dlamini' });
    expect(res.status).toBe(201);
    expect(res.body.data.loginCode).toEqual(expect.any(String));
    expect(res.body.data.pin).toMatch(/^\d{6}$/);
    const op = await MerchantOperator.findOne({ merchantId: stall._id }).lean();
    expect(String(op?.venueId)).toBe(v.venueId);
    expect(op?.eventId).toBeUndefined();
  });

  it('lists, renames and resets the PIN of its own operators', async () => {
    const v = await ownedVenue();
    const stall = await Merchant.create({ name: 'Main Bar', venueId: v.venueId });
    const created = await request(app).post(`/api/tickets/venue/stalls/${stall._id}/operators`).set('Authorization', v.auth).send({ fullName: 'Thabo' });
    const opId = created.body.data.operator._id;
    const list = await request(app).get(`/api/tickets/venue/stalls/${stall._id}/operators`).set('Authorization', v.auth);
    expect(list.body.data.operators).toHaveLength(1);
    const renamed = await request(app).patch(`/api/tickets/venue/operators/${opId}`).set('Authorization', v.auth).send({ fullName: 'Thabo D' });
    expect(renamed.body.data.operator.fullName).toBe('Thabo D');
    const reset = await request(app).post(`/api/tickets/venue/operators/${opId}/reset-pin`).set('Authorization', v.auth).send({});
    expect(reset.status).toBe(200);
    expect(reset.body.data.pin).toMatch(/^\d{6}$/);
  });

  it("404s another venue's operator", async () => {
    const a = await ownedVenue();
    const b = await ownedVenue();
    const theirStall = await Merchant.create({ name: 'B Bar', venueId: b.venueId });
    const made = await request(app).post(`/api/tickets/venue/stalls/${theirStall._id}/operators`).set('Authorization', b.auth).send({ fullName: 'Sipho' });
    const res = await request(app).patch(`/api/tickets/venue/operators/${made.body.data.operator._id}`).set('Authorization', a.auth).send({ fullName: 'Hijack' });
    expect(res.status).toBe(404);
  });
});
