// api/src/routes/__tests__/eventTagRegistry.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { signVendorToken, signSuperAdminToken } from '@/__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { GateOperator } from '@models/gateOperator.model';
import { GateOperatorAuthService } from '@services/gateOperatorAuth.service';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { EventTag } from '@models/eventTag.model';

const PIN = '123456';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/** A cashless event plus its organizer's own dashboard token. */
async function seedCashlessEvent() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  return {
    eventId: String(eventId),
    vendorId: String(vendorId),
    // The organizer holds ISSUE_TAGS through the OWNER role, which is what lets
    // them register a whole tag order without hiring a desk first.
    organizerToken: signVendorToken(String(vendorId), { permissions: [TicketsPermission.ISSUE_TAGS] }),
  };
}

/** A real register-desk row → a real login → the token the route actually sees. */
async function loginDesk(opts: {
  vendorId: string; loginCode: string; grants?: string[]; eventIds?: string[];
}) {
  await GateOperator.create({
    fullName: 'Desk Dumi',
    scope: 'organizer',
    vendorId: new mongoose.Types.ObjectId(opts.vendorId),
    eventIds: (opts.eventIds ?? []).map((id) => new mongoose.Types.ObjectId(id)),
    loginCode: opts.loginCode,
    pin: PIN,
    grants: opts.grants ?? [OperatorGrant.ISSUE_TAGS],
  });
  return GateOperatorAuthService.login(opts.loginCode, PIN);
}

describe('the event tag register — who may fill it', () => {
  it('lets the Register desk enrol a tag into the event it works', async () => {
    const { eventId, vendorId } = await seedCashlessEvent();
    const { accessToken } = await loginDesk({ vendorId, loginCode: '910001', eventIds: [eventId] });

    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ bandUid: '04A2:2B:1C' });

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('registered');
    expect(res.body.data.counts.active).toBe(1);
    expect(await EventTag.countDocuments({ eventId, bandUid: '04a22b1c' })).toBe(1);
  });

  it('403s a gate operator who was never given the Register grant', async () => {
    const { eventId, vendorId } = await seedCashlessEvent();
    const { accessToken } = await loginDesk({ vendorId, loginCode: '910002', grants: [] });

    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ bandUid: '04a22b1c' });

    expect(res.status).toBe(403);
  });

  it('403s a desk posted to a DIFFERENT event of the same organizer', async () => {
    const { eventId, vendorId } = await seedCashlessEvent();
    const elsewhere = await seedPublishedEvent({ vendorId: new mongoose.Types.ObjectId(vendorId) });
    const { accessToken } = await loginDesk({ vendorId, loginCode: '910003', eventIds: [elsewhere.eventId] });

    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ bandUid: '04a22b1c' });

    expect(res.status).toBe(403);
    expect(await EventTag.countDocuments({})).toBe(0);
  });

  it("403s another organizer's staff entirely", async () => {
    const { eventId } = await seedCashlessEvent();
    const stranger = new mongoose.Types.ObjectId().toString();
    const { accessToken } = await loginDesk({ vendorId: stranger, loginCode: '910004' });

    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ bandUid: '04a22b1c' });

    expect(res.status).toBe(403);
  });

  it('lets the organizer paste a whole tag order and reports every line back', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();

    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ bandUids: ['04a22b01', '04a22b02', 'nope'] });

    expect(res.status).toBe(200);
    expect(res.body.data.registered).toEqual(['04a22b01', '04a22b02']);
    expect(res.body.data.rejected).toHaveLength(1);
  });

  it('rejects a malformed uid with a 400 the operator can act on', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();

    const res = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ bandUid: '04a2' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/4 bytes/i);
  });

  it('lists and retires from the register', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();
    await request(app).post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${organizerToken}`).send({ bandUid: '04a22b1c' });

    const retire = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry/retire`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ bandUid: '04a22b1c', reason: 'snapped' });
    expect(retire.status).toBe(200);
    expect(retire.body.data.counts).toEqual({ active: 0, retired: 1, total: 1 });

    const list = await request(app)
      .get(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${organizerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.tags).toHaveLength(1);
    expect(list.body.data.tags[0].status).toBe('retired');
    expect(list.body.data.tags[0].retiredReason).toBe('snapped');
  });

  it('does not shadow the wallet-detail route that shares the /tags prefix', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();

    // "registry" must not be read as a walletId. A 404/500 here would mean the
    // literal route lost its place above /tags/:walletId.
    const res = await request(app)
      .get(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ active: 0, retired: 0, total: 0 });
  });
});

describe('only a registered tag works at the event', () => {
  /** A sold ticket at a cashless event, plus a desk that may bind tags to it. */
  async function seedBindable(loginCode: string) {
    const { eventId, vendorId } = await seedCashlessEvent();
    const ticket = await Ticket.create({
      eventId, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD,
    });
    const { accessToken } = await loginDesk({ vendorId, loginCode, eventIds: [eventId] });
    return { eventId, accessToken, ticketId: ticket.ticketId };
  }

  it('refuses to bind a tag the organizer never registered', async () => {
    const { accessToken, ticketId } = await seedBindable('910010');

    const res = await request(app)
      .post('/api/tickets/scans/bind-band')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ticketId, bandUid: '04a22b1c' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not registered for this event/i);
  });

  it('binds it the moment the desk registers it', async () => {
    const { eventId, accessToken, ticketId } = await seedBindable('910011');

    await request(app).post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${accessToken}`).send({ bandUid: '04a22b1c' });

    const res = await request(app)
      .post('/api/tickets/scans/bind-band')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ticketId, bandUid: '04a22b1c' });

    expect(res.status).toBe(200);
    expect(res.body.data.wallet.bandUid).toBe('04a22b1c');
  });

  it("refuses a tag registered to somebody else's event", async () => {
    const { accessToken, ticketId } = await seedBindable('910012');
    // Registered — but for a show that is not this one.
    await EventTag.create({
      eventId: new mongoose.Types.ObjectId(), bandUid: '04a22b1c', status: 'active', registeredAt: new Date(),
    });

    const res = await request(app)
      .post('/api/tickets/scans/bind-band')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ticketId, bandUid: '04a22b1c' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not registered for this event/i);
  });

  it('refuses a tag the organizer has retired', async () => {
    const { eventId, accessToken, ticketId } = await seedBindable('910013');
    await request(app).post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${accessToken}`).send({ bandUid: '04a22b1c' });
    await request(app).post(`/api/tickets/events/${eventId}/tags/registry/retire`)
      .set('Authorization', `Bearer ${accessToken}`).send({ bandUid: '04a22b1c', reason: 'stolen' });

    const res = await request(app)
      .post('/api/tickets/scans/bind-band')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ticketId, bandUid: '04a22b1c' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not registered for this event/i);
  });
});

describe('Carrot staff working the register on an organizer\'s behalf', () => {
  // A super-admin token carries an EMPTY permissions array — platform staff are
  // authorised by the isSuperAdmin claim, not by holding every organizer's
  // permissions. loadOwnedCashlessEvent already reads that claim ("or is
  // platform staff"), so the route gate has to let them reach it.
  it('lists the register of an organizer they do not own', async () => {
    const { eventId } = await seedCashlessEvent();

    const res = await request(app)
      .get(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${signSuperAdminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.counts).toEqual({ active: 0, retired: 0, total: 0 });
  });

  it('enrols a tag order and retires a tag on that event', async () => {
    const { eventId } = await seedCashlessEvent();
    const admin = signSuperAdminToken();

    const registered = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ bandUid: '04a22b1c' });
    expect(registered.status).toBe(200);
    expect(registered.body.data.outcome).toBe('registered');

    const retired = await request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry/retire`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ bandUid: '04a22b1c' });
    expect(retired.status).toBe(200);
    expect(retired.body.data.counts).toEqual({ active: 0, retired: 1, total: 1 });
  });

  it('still 403s an ordinary organizer who lacks the permission', async () => {
    // The bypass is the isSuperAdmin claim alone — it must not widen the gate
    // for everyone else, or a SALES sub-user could fill the register.
    const { vendorId, eventId } = await seedCashlessEvent();

    const res = await request(app)
      .get(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId, { permissions: [] })}`);

    expect(res.status).toBe(403);
  });
});
