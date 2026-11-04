import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedEventWaiter, seedVenue, seedVenueWaiter } from '@/__tests__/helpers/venueFloor';
import { Venue } from '@models/venue.model';
import { Waiter } from '@models/waiter.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { WaiterPermission } from '@interfaces/waiter.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const login = (loginCode: string, pin = '123456') => request(app).post('/api/operator/login').send({ loginCode, pin });

describe('venue waiter sign-in', () => {
  it('signs in carrying the venue, its currency and live permissions', async () => {
    const venue = await seedVenue({ name: 'Kwa-Linda Lounge', currency: 'SZL' });
    const w = await seedVenueWaiter(venue);
    const res = await login(w.loginCode);
    expect(res.status).toBe(200);
    expect(res.body.data.type).toBe('waiter');
    expect(res.body.data.operator).toMatchObject({
      id: w.waiterId, fullName: 'Sipho', scope: 'organizer', eventId: null,
      venueId: venue.venueId, venueName: 'Kwa-Linda Lounge', currency: 'SZL',
    });
    expect(res.body.data.operator.permissions).toEqual(expect.arrayContaining([WaiterPermission.MANAGE_TABLES, WaiterPermission.SETTLE_TABLES]));
    const claims = jwt.verify(res.body.data.accessToken, JWT_SECRET) as Record<string, unknown>;
    expect(claims['venueId']).toBe(venue.venueId);
    expect(claims['eventId']).toBeUndefined();
  });

  it('an event waiter signs in exactly as before', async () => {
    const w = await seedEventWaiter();
    const res = await login(w.loginCode);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.operator).sort()).toEqual(['eventId', 'fullName', 'id', 'scope']);
  });

  it('a suspended venue refuses sign-in and does not reset the lockout counter', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    await login(w.loginCode, '000000');
    await Venue.updateOne({ _id: venue.venueId }, { $set: { status: 'suspended' } });
    const res = await login(w.loginCode);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Venue trading is suspended');
    expect((await Waiter.findById(w.waiterId))!.failedPinAttempts).toBe(1);
  });

  it('an issued token stops working the moment the venue is suspended', async () => {
    const venue = await seedVenue();
    const w = await seedVenueWaiter(venue);
    expect((await request(app).get('/api/waiter/venue').set('Authorization', w.auth)).status).toBe(200);
    await Venue.updateOne({ _id: venue.venueId }, { $set: { status: 'suspended' } });
    const res = await request(app).get('/api/waiter/venue').set('Authorization', w.auth);
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Venue trading is suspended');
  });
});

describe('GET /api/waiter/venue and the kind refusals', () => {
  it('tells a venue waiter where they work and what they may do right now', async () => {
    const venue = await seedVenue({ name: 'Kwa-Linda Lounge', currency: 'ZAR' });
    const w = await seedVenueWaiter(venue, { grants: [] });
    const res = await request(app).get('/api/waiter/venue').set('Authorization', w.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.venue).toEqual({ id: venue.venueId, name: 'Kwa-Linda Lounge', currency: 'ZAR' });
    expect(res.body.data.permissions).not.toContain(WaiterPermission.SETTLE_TABLES);
    await Waiter.updateOne({ _id: w.waiterId }, { $set: { grants: [OperatorGrant.SETTLE_TABLES] } });
    const again = await request(app).get('/api/waiter/venue').set('Authorization', w.auth);
    expect(again.body.data.permissions).toContain(WaiterPermission.SETTLE_TABLES);
  });

  it('refuses an event waiter on the venue route', async () => {
    const w = await seedEventWaiter();
    const res = await request(app).get('/api/waiter/venue').set('Authorization', w.auth);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('That is a venue feature');
  });

  it.each([
    ['get', '/api/waiter/events'],
    ['get', '/api/waiter/balance?bandUid=04a1b2c3'],
    ['post', '/api/waiter/tables/000000000000000000000001/items'],
    ['post', '/api/waiter/tables/000000000000000000000001/settle'],
    ['post', '/api/waiter/tables/000000000000000000000001/stalls/000000000000000000000002/accept'],
  ] as const)('refuses a venue waiter on the event-only %s %s', async (method, url) => {
    const w = await seedVenueWaiter(await seedVenue());
    const res = await request(app)[method](url).set('Authorization', w.auth).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("That isn't used at venues");
  });
});

describe('venue till sign-in', () => {
  it('now carries the venue currency', async () => {
    const venue = await seedVenue({ currency: 'ZAR' });
    const stall = await Merchant.create({ name: 'Main Bar', venueId: venue.venueId });
    await MerchantOperator.create({ fullName: 'Nomsa', merchantId: stall._id, venueId: venue.venueId, loginCode: 'VT9001', pin: '111111' });
    const res = await login('VT9001', '111111');
    expect(res.status).toBe(200);
    expect(res.body.data.operator).toMatchObject({ venueId: venue.venueId, currency: 'ZAR' });
  });
});
