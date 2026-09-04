// api/src/routes/__tests__/tagAdmin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';
import { EventStatus } from '@interfaces/event.interface';
import { enrolTags } from '@/__tests__/helpers/eventTags';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR = '64c000000000000000000a01';

const token = (perms: string[]) =>
  jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner', permissions: perms, isSuperAdmin: false, vendorId: VENDOR }, JWT_SECRET);

const ADMIN = () => token(['tickets:manage_access']);

async function setup(bandUid: string | null = '105d0001') {
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(VENDOR), name: 'Fest', venue: 'V',
    eventDate: future, startTime: future, endTime: future,
    status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const wallet = await Wallet.create({
    eventId: event._id, ticketId: new mongoose.Types.ObjectId(), bandUid,
    balance: 9000, cashFundedBalance: 0, status: 'active',
  });
  if (bandUid) {
    await BandBinding.create({ walletId: wallet._id, eventId: event._id, bandUid, boundAt: new Date() });
  }
  // Reissue binds a REPLACEMENT tag, and a tag only binds if it is in this
  // event's register — so the organizer's spare stock has to be in the box, not
  // just the one that was lost.
  await enrolTags(event._id, '105d0001', 'f0e50001', 'f0e50002', '7a0e0001');
  return { event, wallet };
}

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('deactivate', () => {
  it('releases a lost tag and keeps the balance on the wallet', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/deactivate`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ reason: 'lost at the bar' });

    expect(res.status).toBe(200);
    const after = await Wallet.findById(wallet._id);
    expect(after!.bandUid).toBeNull();
    // The money is the wallet's, not the plastic's.
    expect(after!.balance).toBe(9000);
    const binding = await BandBinding.findOne({ walletId: wallet._id });
    expect(binding!.unboundReason).toBe('lost at the bar');
  });

  it('403s without manage_access', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/deactivate`)
      .set('Authorization', `Bearer ${token(['tickets:view_revenue'])}`)
      .send({ reason: 'nope' });

    expect(res.status).toBe(403);
  });

  it('requires a reason — the reason IS the audit record', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/deactivate`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('reissue', () => {
  it('moves the balance onto a fresh tag after the old one was reported lost', async () => {
    const { event, wallet } = await setup();
    await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/deactivate`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ reason: 'lost' });

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: 'f0e50001' });

    expect(res.status).toBe(200);
    const after = await Wallet.findById(wallet._id);
    expect(after!.bandUid).toBe('f0e50001');
    expect(after!.balance).toBe(9000);
  });

  it('reissues in one step from a tag that is still bound', async () => {
    // The desk case: someone hands over a damaged tag and wants a new one.
    // Requiring "report lost" first would be two trips for one action.
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: 'f0e50002' });

    expect(res.status).toBe(200);
    const after = await Wallet.findById(wallet._id);
    expect(after!.bandUid).toBe('f0e50002');
    expect(after!.balance).toBe(9000);
    // The old binding is closed with an audit trail, not silently dropped.
    const old = await BandBinding.findOne({ walletId: wallet._id, bandUid: '105d0001' });
    expect(old!.unboundAt).toBeTruthy();
    expect(old!.unboundReason).toMatch(/reissue/i);
  });

  it('409s when the new tag is already issued at this event', async () => {
    const { event, wallet } = await setup();
    await Wallet.create({
      eventId: event._id, ticketId: new mongoose.Types.ObjectId(), bandUid: '7a0e0001',
      balance: 0, cashFundedBalance: 0, status: 'active',
    });

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: '7a0e0001' });

    expect(res.status).toBe(409);
    expect(await Wallet.findById(wallet._id).then((w) => w!.bandUid)).toBe('105d0001');
  });

  it('404s a wallet belonging to a different event', async () => {
    const { event } = await setup();
    const otherWallet = await Wallet.create({
      eventId: new mongoose.Types.ObjectId(), ticketId: new mongoose.Types.ObjectId(),
      bandUid: null, balance: 0, cashFundedBalance: 0, status: 'active',
    });

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${otherWallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: 'f0e50003' });

    expect(res.status).toBe(404);
  });

  // The dashboard form takes whatever the reader/typist produced. Storing it
  // raw meant the cashier/merchant/gate lookups (all canonical) found nothing,
  // and the same plastic could be issued a second time under another spelling.
  it('stores the CANONICAL uid when the organizer types a colon/upper-case form', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: 'F0:E5:00:01' });

    expect(res.status).toBe(200);
    expect(res.body.data.bandUid).toBe('f0e50001');
    expect((await Wallet.findById(wallet._id))!.bandUid).toBe('f0e50001');
    expect(await Wallet.countDocuments({ eventId: event._id, bandUid: 'f0e50001' })).toBe(1);
  });

  it('409s a differently-spelled uid that is already issued at this event', async () => {
    const { event, wallet } = await setup();
    await Wallet.create({
      eventId: event._id, ticketId: new mongoose.Types.ObjectId(), bandUid: '7a0e0001',
      balance: 0, cashFundedBalance: 0, status: 'active',
    });

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: '7A:0E:00:01' });

    expect(res.status).toBe(409);
    expect((await Wallet.findById(wallet._id))!.bandUid).toBe('105d0001');
  });

  it('400s a malformed uid and leaves the current tag working', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: 'not-hex!' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/hex/i);
    expect((await Wallet.findById(wallet._id))!.bandUid).toBe('105d0001');
  });

  // Reissue used to unbind FIRST and only then find out the spare was not in
  // the register: a 400 for the organizer, and an attendee whose old tag had
  // just been killed for nothing.
  it('400s an UNREGISTERED replacement WITHOUT stripping the working tag', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: 'deadbeef' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not registered/i);
    const after = await Wallet.findById(wallet._id);
    expect(after!.bandUid).toBe('105d0001');
    expect(after!.balance).toBe(9000);
    const old = await BandBinding.findOne({ walletId: wallet._id, bandUid: '105d0001' });
    expect(old!.unboundAt).toBeUndefined();
    expect(await BandBinding.countDocuments({ walletId: wallet._id })).toBe(1);
  });
});

describe('office refund', () => {
  const REFUNDER = () => token(['tickets:refund_ticket']);

  it('403s without refund_ticket', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/refund`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ amount: 1000, clientTxnId: 'r1' });

    expect(res.status).toBe(403);
  });

  it('rejects a rand amount — the wire is integer cents', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/refund`)
      .set('Authorization', `Bearer ${REFUNDER()}`)
      .send({ amount: 12.5, clientTxnId: 'r2' });

    expect(res.status).toBe(400);
  });

  it('requires an idempotency key so a double submit cannot double-refund', async () => {
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/refund`)
      .set('Authorization', `Bearer ${REFUNDER()}`)
      .send({ amount: 1000 });

    expect(res.status).toBe(400);
  });

  it('409s a reused clientTxnId carrying a DIFFERENT amount, and replays the same amount', async () => {
    const { event, wallet } = await setup();
    const url = `/api/tickets/events/${event._id}/tags/${wallet._id}/refund`;

    const first = await request(app).post(url).set('Authorization', `Bearer ${REFUNDER()}`)
      .send({ amount: 1000, clientTxnId: 'r-dup' });
    expect(first.status).toBe(200);
    expect(first.body.data.balance).toBe(8000);

    const mismatch = await request(app).post(url).set('Authorization', `Bearer ${REFUNDER()}`)
      .send({ amount: 2000, clientTxnId: 'r-dup' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.message).toMatch(/clientTxnId already used with a different amount/);

    const replay = await request(app).post(url).set('Authorization', `Bearer ${REFUNDER()}`)
      .send({ amount: 1000, clientTxnId: 'r-dup' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.withdrawalId).toBe(first.body.data.withdrawalId);
    expect((await Wallet.findById(wallet._id))!.balance).toBe(8000);
  });
});
