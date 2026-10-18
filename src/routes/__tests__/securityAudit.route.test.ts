// Security regression suite: authorization and concurrency boundaries.
// Uses disposable local MongoDB; storage and message delivery are mocked.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@config/jwt.config';
import { RefreshToken } from '@models/refreshToken.model';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import app from '@/app';
import { BuyerOtp } from '@models/buyerOtp.model';
import { Buyer } from '@models/buyer.model';
import { Reseller } from '@models/reseller.model';
import { ResellerOperator } from '@models/resellerOperator.model';
import { HandoffToken } from '@models/handoffToken.model';
import { Vendor } from '@models/vendor.model';
import { SecurityRateLimit } from '@models/securityRateLimit.model';
import { Event } from '@models/event.model';
import { OtpService } from '@services/otp.service';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { resolveOperatorEventScope } from '@services/operatorEventScope.service';
import { R2Service } from '@utils/r2.service';
import { SmsService } from '@services/sms.service';
import { seedPublishedEvent, seedOperator } from '@/__tests__/helpers/fixtures';
import { signVendorToken } from '@/__tests__/helpers/auth';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { TicketService } from '@services/ticket.service';
import { GateOperator } from '@models/gateOperator.model';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';


jest.mock('@services/sms.service', () => ({ SmsService: { sendOtp: jest.fn().mockResolvedValue(true) } }));
jest.mock('@services/email.service', () => ({ EmailService: { sendOtp: jest.fn().mockResolvedValue(true) } }));

let db: MongoMemoryReplSet;
beforeAll(async () => {
  db = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { systemBinary: '/Users/lasliegeorgesjr/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6' } });
  await mongoose.connect(db.getUri());
  await Promise.all([BuyerOtp.init(), Buyer.init(), HandoffToken.init(), Reseller.init(), ResellerOperator.init(), SecurityRateLimit.init()]);
}, 60000);
beforeEach(() => { jest.spyOn(R2Service, 'deleteEventMediaByUrl').mockResolvedValue(undefined); });
afterEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});
afterAll(async () => { await mongoose.disconnect(); if (db) await db.stop(); });

async function ownedEvent() {
  const vendor = await Vendor.create({ businessName: 'Security test', email: `${new mongoose.Types.ObjectId()}@example.com`, password: 'secure-test-password' });
  const seeded = await seedPublishedEvent({ vendorId: vendor._id });
  return { ...seeded, vendor };
}
const destination = '+26878422613'; // Local fixture only; never delivered.
const id = { channel: 'sms' as const, value: destination };
async function otp(attempts = 0) {
  return BuyerOtp.create({ audience: 'buyer', channel: 'sms', destination,
    codeHash: crypto.createHash('sha256').update('123456').digest('hex'),
    expiresAt: new Date(Date.now() + 600000), attempts, consumed: false });
}

describe('Security boundaries', () => {
  it('caps PIN comparisons at five even when twenty guesses arrive together', async () => {
    const seeded = await seedOperator();
    const comparisons = jest.spyOn(ResellerOperator.prototype, 'comparePin');
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => ResellerAuthService.login(seeded.loginCode, '000000')));
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(comparisons).toHaveBeenCalledTimes(5);
    const row = await ResellerOperator.findById(seeded.operator._id);
    expect(row?.failedPinAttempts).toBe(5);
  });
  it('denies event-media mutation to a scanner even within their organizer', async () => {
    const owned = await ownedEvent();
    await GateOperator.create({ fullName: 'Scanner', loginCode: 'SCAN01', pin: '654321', scope: 'organizer', vendorId: owned.vendorId });
    const login = await GateOperatorAuthService.login('SCAN01', '654321');
    const response = await request(app).delete(`/api/media/events/${owned.eventId}`)
      .set('Authorization', `Bearer ${login.accessToken}`).send({ url: 'events/anything', mediaType: 'poster' });
    expect(response.status).toBe(403);
    expect(R2Service.deleteEventMediaByUrl).not.toHaveBeenCalled();
  });
  it('rejects nested and repeated queries while the process remains healthy', async () => {
    for (const query of ['tab%5BtoString%5D=x', 'tab=x&tab=y', 'tab%5B%5D=x']) {
      expect((await request(app).get(`/api/public/feed?${query}`)).status).toBe(400);
      expect((await request(app).get('/health')).status).toBe(200);
    }
  });

  it('turns an async callback rejection outside a controller catch into a 500', async () => {
    jest.spyOn(TicketService, 'getMomoSaleByExternalId').mockRejectedValue(new Error('Dependency unavailable'));
    expect((await request(app).post('/api/momo/callback').send({ externalId: 'test' })).status).toBe(500);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('allows deleting an actual owned object and rejects unknown media types before storage', async () => {
    const owned = await ownedEvent();
    const url = `events/${owned.eventId}/poster/owned.png`;
    await Event.updateOne({ _id: owned.eventId }, { posterUrl: url });
    const token = signVendorToken(owned.vendorId, { authVersion: owned.vendor.authVersion });
    const bad = await request(app).delete(`/api/media/events/${owned.eventId}`).set('Authorization', `Bearer ${token}`).send({ url, mediaType: 'unknown' });
    expect(bad.status).toBe(400);
    expect(R2Service.deleteEventMediaByUrl).not.toHaveBeenCalled();
    const good = await request(app).delete(`/api/media/events/${owned.eventId}`).set('Authorization', `Bearer ${token}`).send({ url, mediaType: 'poster' });
    expect(good.status).toBe(200);
    expect(R2Service.deleteEventMediaByUrl).toHaveBeenCalledWith(url);
  });

  it('rolls back the OTP claim after a failed account mutation and permits retry', async () => {
    await otp();
    await expect(OtpService.withVerified('buyer', id, '123456', async () => { throw new Error('save failed'); })).rejects.toThrow('save failed');
    expect((await BuyerOtp.findOne({ destination }))?.consumed).toBe(false);
    await expect(OtpService.withVerified('buyer', id, '123456', async () => true)).resolves.toBe(true);
  });

  it('admits only one concurrent refresh and stops refresh after password change', async () => {
    const owned = await ownedEvent();
    const login = await TicketsAuthService.login(owned.vendor.email!, 'secure-test-password');
    const results = await Promise.allSettled([TicketsAuthService.refreshAccessToken(login.refreshToken), TicketsAuthService.refreshAccessToken(login.refreshToken)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const next = results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ refreshToken: string }>;
    owned.vendor.password = 'changed-test-password';
    await owned.vendor.save();
    await expect(TicketsAuthService.refreshAccessToken(next.value.refreshToken)).rejects.toThrow();
  });

  it('allows active organizer sessions and immediately refuses a suspended account', async () => {
    const owned = await ownedEvent();
    const token = signVendorToken(owned.vendorId, { authVersion: owned.vendor.authVersion });
    const access = () => request(app).get('/api/tickets/events').set('Authorization', `Bearer ${token}`);
    expect((await access()).status).toBe(200);
    await Vendor.updateOne({ _id: owned.vendorId }, { isActive: false });
    expect((await access()).status).toBe(401);
  });
  it('refuses foreign media even when the caller owns the route event', async () => {
    const owned = await ownedEvent();
    const foreign = await ownedEvent();
    const url = `https://cdn.example/events/${foreign.eventId}/poster/victim.png`;
    await Event.updateOne({ _id: foreign.eventId }, { posterUrl: url });
    const response = await request(app).delete(`/api/media/events/${owned.eventId}`)
      .set('Authorization', `Bearer ${signVendorToken(owned.vendorId, { authVersion: owned.vendor.authVersion })}`)
      .send({ url, mediaType: 'poster' });
    expect(response.status).toBe(404);
    expect(R2Service.deleteEventMediaByUrl).not.toHaveBeenCalled();
    expect((await Event.findById(foreign.eventId))?.posterUrl).toBe(url);
  });

  it('refuses a handoff token on normal API authentication', async () => {
    const owned = await ownedEvent();
    const handoff = TicketsAuthService.mintSocialHandoff({ vendorId: owned.vendorId,
      userType: 'vendor', authVersion: owned.vendor.authVersion, permissions: [TicketsPermission.VIEW_EVENTS] });
    for (let i = 0; i < 2; i++) {
      const response = await request(app).post('/api/tickets/auth/handoff')
        .set('Authorization', `Bearer ${handoff}`).send({});
      expect(response.status).toBe(401);
    }
    expect(await HandoffToken.countDocuments()).toBe(0);
  });

  it('refuses an exchanged handoff as a bearer token', async () => {
    const owned = await ownedEvent();
    const handoff = TicketsAuthService.mintSocialHandoff({ vendorId: owned.vendorId,
      userType: 'vendor', authVersion: owned.vendor.authVersion, permissions: [TicketsPermission.VIEW_EVENTS] });
    await TicketsAuthService.exchangeSocialHandoff(handoff);
    const response = await request(app).post('/api/tickets/auth/handoff')
      .set('Authorization', `Bearer ${handoff}`).send({});
    expect(response.status).toBe(401);
    expect(await HandoffToken.countDocuments()).toBe(1);
  });

  it('commits just one account mutation for concurrent valid OTP proofs', async () => {
    const buyer = await Buyer.create({ phone: destination, password: 'original-password' });
    await otp();
    const action = async (session: mongoose.ClientSession) => {
      await Buyer.updateOne({ _id: buyer._id }, { $set: { bio: 'changed' } }, { session });
      return true;
    };
    const results = await Promise.allSettled(Array.from({ length: 2 }, () =>
      OtpService.withVerified('buyer', id, '123456', action)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await BuyerOtp.findOne({ destination }))?.consumed).toBe(true);
  });

  it('allows only one parallel guess when just one attempt remains', async () => {
    await otp(4);
    const original = BuyerOtp.findOne.bind(BuyerOtp);
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    // Synchronize actual Mongo reads to prove the read/save race deterministically.
    jest.spyOn(BuyerOtp, 'findOne').mockImplementation(((filter: any) => ({
      sort: (sort: any) => original(filter).sort(sort).then(async row => {
        reads++; if (reads === 20) release(); await barrier; return row;
      }),
    })) as any);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
      OtpService.withVerified('buyer', id, '999999', async () => true)));
    expect(results.filter(r => r.status === 'rejected' && r.reason.message.includes('incorrect'))).toHaveLength(1);
    jest.restoreAllMocks();
    expect((await BuyerOtp.findOne({ destination }))?.attempts).toBe(5);
  });

  it('allows only one simultaneous send per destination cooldown', async () => {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => OtpService.issue('buyer', id, 'failed')));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(SmsService.sendOtp).toHaveBeenCalledTimes(1);
    expect(await BuyerOtp.countDocuments({ destination })).toBe(1);
  });

  it('revokes financial-report access immediately for a deactivated reseller manager', async () => {
    const seeded = await seedOperator({ role: 'reseller_hub_manager' });
    const login = await ResellerAuthService.login(seeded.loginCode, seeded.pin);
    await ResellerOperator.updateOne({ _id: seeded.operator._id }, { isActive: false });
    await Reseller.updateOne({ _id: seeded.resellerId }, { status: 'suspended' });
    const response = await request(app).get('/api/reseller/reports/summary')
      .set('Authorization', `Bearer ${login.accessToken}`);
    expect(response.status).toBe(401);
  });

  it('fails closed when a reseller operator was deleted', async () => {
    const seeded = await seedOperator();
    const companyEvent = new mongoose.Types.ObjectId();
    const operatorEvent = new mongoose.Types.ObjectId();
    await Reseller.updateOne({ _id: seeded.resellerId }, { eventIds: [companyEvent, operatorEvent] });
    await ResellerOperator.updateOne({ _id: seeded.operator._id }, { eventIds: [operatorEvent] });
    const login = await ResellerAuthService.login(seeded.loginCode, seeded.pin);
    const req = { reseller: ResellerAuthService.verifyToken(login.accessToken) } as any;
    expect(await resolveOperatorEventScope(req)).toEqual([String(operatorEvent)]);
    await ResellerOperator.deleteOne({ _id: seeded.operator._id });
    expect(await resolveOperatorEventScope(req)).toEqual([]);
  });

  it('revokes existing buyer tokens after password reset', async () => {
    const buyer = await Buyer.create({ phone: destination, password: 'original-password' });
    const oldToken = BuyerAuthService.signToken(buyer);
    await otp();
    await BuyerAuthService.resetPassword(destination, '123456', 'replacement-password');
    const response = await request(app).get('/api/public/my-tickets')
      .set('Authorization', `Bearer ${oldToken}`);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('SESSION_INVALID');
  });

  it('rejects a pre-security buyer token with a machine-readable session error', async () => {
    const buyer = await Buyer.create({ phone: destination, password: 'original-password' });
    const token = jwt.sign({ buyerId: String(buyer._id), app: 'tickets', userType: 'buyer' }, JWT_SECRET);
    const response = await request(app).get('/api/public/my-tickets').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('SESSION_INVALID');
  });

  it('rejects query operators as refresh credentials without consuming another session', async () => {
    const owned = await ownedEvent();
    const login = await TicketsAuthService.login(owned.vendor.email!, 'secure-test-password');
    const response = await request(app).post('/api/tickets/auth/refresh').send({ refreshToken: { $ne: null } });
    expect(response.status).toBe(400);
    expect(response.body.data).toBeUndefined();
    expect((await RefreshToken.findOne({ token: login.refreshToken }))?.isRevoked).toBe(false);
  });

  it('reports a refresh dependency outage as 500 rather than invalid credentials', async () => {
    jest.spyOn(TicketsAuthService, 'refreshAccessToken').mockRejectedValueOnce(new Error('Database temporarily unavailable'));
    const response = await request(app).post('/api/tickets/auth/refresh').send({ refreshToken: 'test-only' });
    expect(response.status).toBe(500);
    expect(response.body.error).not.toBe('SESSION_INVALID');
  });

  it('keeps a refresh token usable when replacement storage fails', async () => {
    const owned = await ownedEvent();
    const login = await TicketsAuthService.login(owned.vendor.email!, 'secure-test-password');
    jest.spyOn(RefreshToken, 'create').mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
    await expect(TicketsAuthService.refreshAccessToken(login.refreshToken)).rejects.toThrow('Storage temporarily unavailable');
    expect((await RefreshToken.findOne({ token: login.refreshToken }))?.isRevoked).toBe(false);
    const refreshed = await TicketsAuthService.refreshAccessToken(login.refreshToken);
    expect(refreshed.refreshToken).not.toBe(login.refreshToken);
    await expect(TicketsAuthService.verifyAndResolveSession(refreshed.accessToken)).resolves.toMatchObject({ userType: 'vendor' });
    await expect(TicketsAuthService.refreshAccessToken(login.refreshToken)).rejects.toThrow('Invalid or expired');
  });

  it('accepts a new signup token immediately and after a profile read', async () => {
    await otp();
    const registered = await request(app).post('/api/public/auth/register')
      .send({ identifier: destination, code: '123456', password: 'signup-test-password', name: 'New buyer' });
    expect(registered.status).toBe(200);
    const token = registered.body.data.accessToken;
    expect((await request(app).get('/api/social/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/api/public/my-tickets').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });

  it('throttles repeated wrong-password buyer logins with a retry deadline', async () => {
    await Buyer.create({ phone: destination, password: 'original-password' });
    const responses: number[] = [];
    for (let i = 0; i < 20; i++) {
      responses.push((await request(app).post('/api/public/auth/login')
        .send({ identifier: destination, password: 'wrong-password' })).status);
    }
    expect(responses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(responses.slice(10)).toEqual(Array(10).fill(429));
    const response = await request(app).post('/api/public/auth/login')
      .send({ identifier: destination, password: 'original-password' });
    expect(response.status).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });
});
