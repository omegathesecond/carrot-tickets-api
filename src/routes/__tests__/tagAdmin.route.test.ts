// api/src/routes/__tests__/tagAdmin.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { BandBinding } from '@models/bandBinding.model';
import { EventStatus } from '@interfaces/event.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR = '64c000000000000000000a01';

const token = (perms: string[]) =>
  jwt.sign({ app: 'tickets', userType: 'vendor', role: 'tickets_owner', permissions: perms, isSuperAdmin: false, vendorId: VENDOR }, JWT_SECRET);

const ADMIN = () => token(['tickets:manage_access']);

async function setup(bandUid: string | null = 'LOST1') {
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
  return { event, wallet };
}

beforeAll(connectTestDb);
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
      .send({ bandUid: 'FRESH1' });

    expect(res.status).toBe(200);
    const after = await Wallet.findById(wallet._id);
    expect(after!.bandUid).toBe('FRESH1');
    expect(after!.balance).toBe(9000);
  });

  it('reissues in one step from a tag that is still bound', async () => {
    // The desk case: someone hands over a damaged tag and wants a new one.
    // Requiring "report lost" first would be two trips for one action.
    const { event, wallet } = await setup();

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: 'FRESH2' });

    expect(res.status).toBe(200);
    const after = await Wallet.findById(wallet._id);
    expect(after!.bandUid).toBe('FRESH2');
    expect(after!.balance).toBe(9000);
    // The old binding is closed with an audit trail, not silently dropped.
    const old = await BandBinding.findOne({ walletId: wallet._id, bandUid: 'LOST1' });
    expect(old!.unboundAt).toBeTruthy();
    expect(old!.unboundReason).toMatch(/reissue/i);
  });

  it('409s when the new tag is already issued at this event', async () => {
    const { event, wallet } = await setup();
    await Wallet.create({
      eventId: event._id, ticketId: new mongoose.Types.ObjectId(), bandUid: 'TAKEN1',
      balance: 0, cashFundedBalance: 0, status: 'active',
    });

    const res = await request(app)
      .post(`/api/tickets/events/${event._id}/tags/${wallet._id}/reissue`)
      .set('Authorization', `Bearer ${ADMIN()}`)
      .send({ bandUid: 'TAKEN1' });

    expect(res.status).toBe(409);
    expect(await Wallet.findById(wallet._id).then((w) => w!.bandUid)).toBe('LOST1');
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
      .send({ bandUid: 'FRESH3' });

    expect(res.status).toBe(404);
  });
});
