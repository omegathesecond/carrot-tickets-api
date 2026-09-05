// src/routes/__tests__/tableReport.route.test.ts
import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signVendorToken, signSuperAdminToken } from '@/__tests__/helpers/auth';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { EVENT, seedStallAndTable } from '@/__tests__/helpers/tables';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { TableService } from '@services/table.service';
import { WalletService } from '@services/wallet.service';

// TableService.settle (needed below to reach a genuinely SETTLED table) opens
// a multi-document transaction, same reasoning as waiterTables.route.test.ts.
beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

/**
 * FIXTURE THE BRIEF ASSUMES BUT NEVER DEFINES (task-13-brief.md's tests call
 * `seedEventWithTables()`, which exists nowhere in the repo). Written here as
 * an explicit first step, per the ruling that amends the brief.
 *
 * Built on the shared stall/table helpers in tables.ts and on
 * TableService.open/addItem/voidTable/settle — never a hand-written document —
 * so this fixture cannot drift from how a table is actually produced. `EVENT`
 * (tables.ts's shared constant, fresh per test FILE) is given a real Event
 * document so loadOwnedCashlessEvent's ownership + cashless checks have
 * something real to read.
 *
 * Produces exactly what task 13's tests need:
 *   - one OPEN table worth 6000 (a stall poured 2x a 3000 item, still on the tab)
 *   - one SETTLED table worth 4500 (charged for real, against a funded tag)
 *   - one VOIDED table worth 3000, reason 'walked out'
 */
async function seedEventWithTables() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  await Event.create({
    _id: EVENT, vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const organizerToken = signVendorToken(String(vendorId), { permissions: [TicketsPermission.VIEW_REVENUE] });

  // OPEN: 2 x 3000 = 6000, never settled or voided.
  const openStall = await seedStallAndTable({ price: 3000, onHand: 10 });
  await TableService.addItem({
    tableId: String(openStall.table._id), eventId: String(EVENT),
    merchantId: openStall.merchantId, productId: openStall.productId, qty: 2, addedBy: 'w1',
  });

  // SETTLED: 1 x 4500, charged for real against a funded tag — settle is a
  // real service call, not a hand-set status:'settled', so this table is
  // exactly what a waiter closing out a tab produces.
  const settleStall = await seedStallAndTable({ price: 4500, onHand: 10 });
  await TableService.addItem({
    tableId: String(settleStall.table._id), eventId: String(EVENT),
    merchantId: settleStall.merchantId, productId: settleStall.productId, qty: 1, addedBy: 'w1',
  });
  const bandUid = 'aa11bb22';
  await enrolTags(EVENT, bandUid);
  const { wallet } = await WalletService.ensureStandaloneWalletForBand({ eventId: String(EVENT), bandUid });
  await WalletService.topUpCash({
    walletId: String(wallet._id), eventId: String(EVENT), amount: 10000,
    recordedBy: 'fixture-desk', recordedByType: 'Cashier', clientTxnId: `fund-${wallet._id}`,
  });
  await TableService.settle({
    // settledBy lands in MerchantCharge.waiterId, which casts to ObjectId —
    // unlike addItem/voidTable's plain-string attribution, this must be one.
    tableId: String(settleStall.table._id), eventId: String(EVENT), bandUid,
    settledBy: String(new mongoose.Types.ObjectId()), staffName: 'Thabo', clientTxnId: 'settle-1',
  });

  // VOIDED: 1 x 3000, walked out — the number that tells the organizer table
  // service is costing them money.
  const voidStall = await seedStallAndTable({ price: 3000, onHand: 10 });
  await TableService.addItem({
    tableId: String(voidStall.table._id), eventId: String(EVENT),
    merchantId: voidStall.merchantId, productId: voidStall.productId, qty: 1, addedBy: 'w1',
  });
  await TableService.voidTable({
    tableId: String(voidStall.table._id), eventId: String(EVENT), reason: 'walked out', voidedBy: 'w1',
  });

  return { eventId: String(EVENT), organizerToken };
}

describe('GET /api/tickets/events/:eventId/tables', () => {
  it('shows what is open, what was settled, and what walked', async () => {
    const { eventId, organizerToken } = await seedEventWithTables();
    const res = await request(app).get(`/api/tickets/events/${eventId}/tables`)
      .set('Authorization', `Bearer ${organizerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totals.openValue).toBe(6000);
    expect(res.body.data.totals.settledValue).toBe(4500);
    // The number that tells an organizer whether table service costs them money.
    expect(res.body.data.totals.voidedValue).toBe(3000);
    expect(res.body.data.voided[0].voidReason).toBe('walked out');
  });

  it('403s another organizer', async () => {
    const { eventId } = await seedEventWithTables();
    const stranger = signVendorToken(new mongoose.Types.ObjectId().toString(), {
      permissions: [TicketsPermission.VIEW_REVENUE],
    });
    const res = await request(app).get(`/api/tickets/events/${eventId}/tables`)
      .set('Authorization', `Bearer ${stranger}`);
    expect(res.status).toBe(403);
  });

  // BEYOND THE BRIEF: a 403 that still hands back the table list would be a
  // guard in name only. Confirms the response carries no table data at all on
  // this path — not merely the right status code.
  it('leaks no table data to a stranger organizer, not just the right status', async () => {
    const { eventId } = await seedEventWithTables();
    const stranger = signVendorToken(new mongoose.Types.ObjectId().toString(), {
      permissions: [TicketsPermission.VIEW_REVENUE],
    });
    const res = await request(app).get(`/api/tickets/events/${eventId}/tables`)
      .set('Authorization', `Bearer ${stranger}`);
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  it('lets Carrot staff read it on an organizer they do not own', async () => {
    const { eventId } = await seedEventWithTables();
    const res = await request(app).get(`/api/tickets/events/${eventId}/tables`)
      .set('Authorization', `Bearer ${signSuperAdminToken()}`);
    expect(res.status).toBe(200);
  });
});
