// api/src/routes/__tests__/tagIssue.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { signVendorToken, signSuperAdminToken } from '@/__tests__/helpers/auth';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

beforeAll(async () => {
  await connectTestDb();
  await Wallet.syncIndexes();
});
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function seedCashlessEvent() {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless: true } });
  return {
    eventId: String(eventId),
    vendorId: String(vendorId),
    organizerToken: signVendorToken(String(vendorId), { permissions: [TicketsPermission.ISSUE_TAGS] }),
  };
}

const issue = (eventId: string, token: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/tickets/events/${eventId}/tags/issue`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

describe('handing out a tag that carries no ticket', () => {
  it('gives the tag a wallet the cashier can then top up', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();
    await enrolTags(eventId, '04a22b1c');

    const res = await issue(eventId, organizerToken, { bandUid: '04a22b1c' });

    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.balance).toBe(0);
    // The cashier finds a wallet by {eventId, bandUid} — the exact lookup that
    // used to 404 with "No wallet for that band/ticket".
    const wallet = await Wallet.findOne({ eventId, bandUid: '04a22b1c' });
    expect(wallet).not.toBeNull();
    expect(wallet!.ticketId).toBeUndefined();
  });

  it('is idempotent — a double tap at the desk does not mint a second wallet', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();
    await enrolTags(eventId, '04a22b1c');

    await issue(eventId, organizerToken, { bandUid: '04a22b1c' });
    const again = await issue(eventId, organizerToken, { bandUid: '04a22b1c' });

    expect(again.status).toBe(200);
    expect(again.body.data.created).toBe(false);
    expect(await Wallet.countDocuments({})).toBe(1);
  });

  it('refuses a tag that is not in this event register, and says so', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();

    const res = await issue(eventId, organizerToken, { bandUid: '04a22b1c' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not registered for this event/i);
    expect(await Wallet.countDocuments({})).toBe(0);
  });

  it('refuses a tag that already belongs to a ticket, with a different message', async () => {
    // At a busy desk these two refusals call for opposite actions, so they must
    // not collapse into one string.
    const { eventId, organizerToken } = await seedCashlessEvent();
    await enrolTags(eventId, '04a22b1c');
    await Wallet.create({
      eventId: new mongoose.Types.ObjectId(eventId), ticketId: new mongoose.Types.ObjectId(),
      bandUid: '04a22b1c', balance: 0, cashFundedBalance: 0, status: 'active',
    });

    const res = await issue(eventId, organizerToken, { bandUid: '04a22b1c' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/belongs to a ticket/i);
  });

  it('rejects a malformed uid with a 400 the operator can act on', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();
    const res = await issue(eventId, organizerToken, { bandUid: '04a2' });
    expect(res.status).toBe(400);
  });

  it('requires a bandUid', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();
    const res = await issue(eventId, organizerToken, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/bandUid/i);
  });

  it('refuses on an event that is not cashless', async () => {
    const { eventId } = await seedPublishedEvent({});
    const { vendorId } = await seedCashlessEvent();
    const token = signVendorToken(String(vendorId), { permissions: [TicketsPermission.ISSUE_TAGS] });
    const res = await issue(String(eventId), token, { bandUid: '04a22b1c' });
    expect(res.status).not.toBe(201);
  });

  it('lets Carrot staff issue on an organizer they do not own', async () => {
    const { eventId } = await seedCashlessEvent();
    await enrolTags(eventId, '04a22b1c');

    const res = await issue(eventId, signSuperAdminToken(), { bandUid: '04a22b1c' });

    expect(res.status).toBe(201);
  });

  it('403s an organizer who does not hold issue_tags', async () => {
    const { eventId, vendorId } = await seedCashlessEvent();
    const res = await issue(eventId, signVendorToken(vendorId, { permissions: [] }), { bandUid: '04a22b1c' });
    expect(res.status).toBe(403);
  });
});

describe('a standalone tag is still fully accounted for', () => {
  it('records the binding so the tag shows up in reports and clone forensics', async () => {
    // A UID-only band is cloneable, so "which band was live on this wallet, and
    // when" has to stay answerable (cashless spec §4) — and the tag
    // registrations report reads BandBinding, so a tag with no row would be
    // invisible on the Balances screen too.
    const { eventId, organizerToken } = await seedCashlessEvent();
    await enrolTags(eventId, '04a22b1c');

    await issue(eventId, organizerToken, { bandUid: '04a22b1c' });

    const binding = await BandBinding.findOne({ eventId, bandUid: '04a22b1c' });
    expect(binding).not.toBeNull();
    expect(binding!.unboundAt).toBeUndefined();
  });

  it('writes only one binding row when the same tag is tapped twice', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();
    await enrolTags(eventId, '04a22b1c');

    await issue(eventId, organizerToken, { bandUid: '04a22b1c' });
    await issue(eventId, organizerToken, { bandUid: '04a22b1c' });

    expect(await BandBinding.countDocuments({ eventId, bandUid: '04a22b1c' })).toBe(1);
  });

  it('will not let a spending tag through the gate', async () => {
    const { eventId, vendorId, organizerToken } = await seedCashlessEvent();
    await enrolTags(eventId, '04a22b1c');
    await issue(eventId, organizerToken, { bandUid: '04a22b1c' });

    const scanner = signVendorToken(vendorId, { permissions: [TicketsPermission.SCAN_TICKETS] });
    const res = await request(app)
      .post('/api/tickets/scans/check-in')
      .set('Authorization', `Bearer ${scanner}`)
      .send({ bandUid: '04a22b1c', expectedEventId: eventId });

    expect(res.status).toBe(400);
    // Not "Ticket not found for that wallet" — that reads like corrupt data and
    // sends the gate hunting for a problem that does not exist.
    expect(res.body.message).toMatch(/spending tag/i);
    expect(res.body.message).not.toMatch(/not found/i);
  });
});

describe('scanning a tag at the desk makes it ready in one tap', () => {
  // The POS Register loop posts {bandUid} per scan. That single tap is a tag
  // going into somebody's hand, so it must come out of it spendable — the
  // handhelds already make this call, which is why this lives on the server.
  const register = (eventId: string, token: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/tickets/events/${eventId}/tags/registry`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('gives the scanned tag a wallet, not just a place in the register', async () => {
    const { eventId, organizerToken } = await seedCashlessEvent();

    const res = await register(eventId, organizerToken, { bandUid: '04a22b1c' });

    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('registered');
    const wallet = await Wallet.findOne({ eventId, bandUid: '04a22b1c' });
    expect(wallet).not.toBeNull();
    expect(wallet!.ticketId).toBeUndefined();
  });

  it('stays a no-op on a re-scan, the way the desk loop relies on', async () => {
    // The sheet re-arms after every tap, so a double-read must read as
    // "already done" rather than an error.
    const { eventId, organizerToken } = await seedCashlessEvent();
    await register(eventId, organizerToken, { bandUid: '04a22b1c' });

    const again = await register(eventId, organizerToken, { bandUid: '04a22b1c' });

    expect(again.status).toBe(200);
    expect(again.body.data.outcome).toBe('already_registered');
    expect(await Wallet.countDocuments({ eventId })).toBe(1);
  });

  it('does not choke on a tag that already carries somebody ticket wallet', async () => {
    // Re-scanning a tag that was bound to a ticket must not turn a harmless
    // re-tap into an error: it already has a wallet, so it is already ready.
    const { eventId, organizerToken } = await seedCashlessEvent();
    await register(eventId, organizerToken, { bandUid: '04a22b1c' });
    await Wallet.updateOne(
      { eventId, bandUid: '04a22b1c' },
      { $set: { ticketId: new mongoose.Types.ObjectId() } },
    );

    const again = await register(eventId, organizerToken, { bandUid: '04a22b1c' });

    expect(again.status).toBe(200);
    expect(await Wallet.countDocuments({ eventId })).toBe(1);
  });

  it('leaves the bulk paste box as a stocking tool — no wallets', async () => {
    // A pasted tag order is 500 tags nobody is holding yet. Minting wallets for
    // them would fill the Balances screen with tags in a box.
    const { eventId, organizerToken } = await seedCashlessEvent();

    const res = await register(eventId, organizerToken, { bandUids: ['04a22b01', '04a22b02'] });

    expect(res.status).toBe(200);
    expect(res.body.data.registered).toEqual(['04a22b01', '04a22b02']);
    expect(await Wallet.countDocuments({ eventId })).toBe(0);
  });
});
