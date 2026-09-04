// api/src/routes/__tests__/cashlessReconciliation.route.test.ts
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { EventStatus } from '@interfaces/event.interface';
import { LedgerAccountType, FloatTag } from '@interfaces/ledger.interface';

/**
 * GET /api/tickets/events/:eventId/cashless/reconciliation — the super-admin
 * view of the three internal ledger checks (accounting identity, journal
 * integrity, stored wallet balance vs journal). Until this route existed the
 * checks were reachable only from tests, so a drifted wallet in production
 * had no way to surface.
 */

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR_A = '64c000000000000000000a01';

function token(opts: { isSuperAdmin?: boolean; vendorId?: string }) {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:view_revenue'], isSuperAdmin: !!opts.isSuperAdmin, vendorId: opts.vendorId,
  }, JWT_SECRET);
}

async function eventFor(vendorId: string, opts: { cashless: boolean }) {
  const start = new Date(Date.now() - 2 * 864e5);
  const end = new Date(start.getTime() + 3 * 3600e3);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId), name: 'Festival', venue: 'V',
    eventDate: start, startTime: start, endTime: end, status: EventStatus.PUBLISHED,
    cashless: opts.cashless,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return (event._id as any).toString() as string;
}

async function walletWithBalance(eventId: string, balance: number): Promise<string> {
  const w = await Wallet.create({
    eventId: new mongoose.Types.ObjectId(eventId),
    ticketId: new mongoose.Types.ObjectId(),
    balance,
  });
  return String(w._id);
}

/** A balanced top-up posting written straight to the journal (no transaction needed). */
async function journalTopup(eventId: string, walletId: string, amount: number, txnId = `topup-${walletId}`) {
  const oid = new mongoose.Types.ObjectId(eventId);
  await LedgerEntry.create([
    { eventId: oid, txnId, accountType: LedgerAccountType.FLOAT, accountRef: null, delta: amount, tag: FloatTag.KESHLESS, refType: 'topup', refId: txnId },
    { eventId: oid, txnId, accountType: LedgerAccountType.WALLET, accountRef: walletId, delta: -amount, refType: 'topup', refId: txnId },
  ]);
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const url = (eventId: string) => `/api/tickets/events/${eventId}/cashless/reconciliation`;

describe('GET /api/tickets/events/:eventId/cashless/reconciliation', () => {
  it("refuses a non-super-admin, even the event's own organizer", async () => {
    const eventId = await eventFor(VENDOR_A, { cashless: true });

    const res = await request(app).get(url(eventId))
      .set('Authorization', `Bearer ${token({ vendorId: VENDOR_A })}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Super admin access required');
  });

  it('returns 404 for an event that does not exist', async () => {
    const res = await request(app).get(url(new mongoose.Types.ObjectId().toString()))
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

    expect(res.status).toBe(404);
    // Pinned to the guard's own message so this cannot pass against the
    // catch-all "Route not found" 404 of an unregistered route.
    expect(res.body.message).toBe('Event not found');
  });

  it('returns 400 for an event that is not cashless', async () => {
    const eventId = await eventFor(VENDOR_A, { cashless: false });

    const res = await request(app).get(url(eventId))
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Event is not cashless');
  });

  it('reports all three checks ok on a consistent ledger', async () => {
    const eventId = await eventFor(VENDOR_A, { cashless: true });
    const walletId = await walletWithBalance(eventId, 5000);
    await journalTopup(eventId, walletId, 5000);

    const res = await request(app).get(url(eventId))
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

    expect(res.status).toBe(200);
    expect(res.body.data.event).toEqual({ id: eventId, name: 'Festival' });
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.invariant).toEqual({
      ok: true, float: 5000, walletsOwed: 5000, merchantsOwed: 0, feesEarned: 0, drift: 0,
    });
    expect(res.body.data.journal).toEqual({ ok: true, unbalancedTxnIds: [] });
    expect(res.body.data.wallets).toEqual({ ok: true, checked: 1, drifted: [], invariantViolations: [] });
  });

  it('names the drifted wallet when its stored balance disagrees with the journal', async () => {
    const eventId = await eventFor(VENDOR_A, { cashless: true });
    const walletId = await walletWithBalance(eventId, 5000);
    await journalTopup(eventId, walletId, 4000);

    const res = await request(app).get(url(eventId))
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    // The journal itself is sound — only the denormalized balance is off.
    expect(res.body.data.invariant.ok).toBe(true);
    expect(res.body.data.journal.ok).toBe(true);
    expect(res.body.data.wallets.ok).toBe(false);
    expect(res.body.data.wallets.drifted).toEqual([
      { walletId, stored: 5000, journal: 4000, drift: 1000 },
    ]);
  });

  it('flags an unbalanced journal transaction by its txnId', async () => {
    const eventId = await eventFor(VENDOR_A, { cashless: true });
    await LedgerEntry.create({
      eventId: new mongoose.Types.ObjectId(eventId),
      txnId: 'rogue-1',
      accountType: LedgerAccountType.FLOAT,
      accountRef: null,
      delta: 9999,
      tag: FloatTag.KESHLESS,
      refType: 'rogue',
      refId: 'r1',
    });

    const res = await request(app).get(url(eventId))
      .set('Authorization', `Bearer ${token({ isSuperAdmin: true })}`);

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.journal).toEqual({ ok: false, unbalancedTxnIds: ['rogue-1'] });
    expect(res.body.data.invariant.ok).toBe(false);
    expect(res.body.data.invariant.drift).toBe(9999);
  });
});
