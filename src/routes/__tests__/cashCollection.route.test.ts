import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Cashier } from '@models/cashier.model';
import { Event } from '@models/event.model';
import { WalletService } from '@services/wallet.service';
import { CashCollection } from '@models/cashCollection.model';
import { CashDeskService } from '@services/cashDesk.service';
import { LedgerService } from '@services/ledger.service';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { FloatTag } from '@interfaces/ledger.interface';
import { EventStatus } from '@interfaces/event.interface';
import { CASHIER_PERMISSIONS } from '@interfaces/cashier.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
const secret = process.env.JWT_SECRET || 'your-secret-key';
beforeAll(connectLedgerTestDb, 60000); afterEach(clearTestDb); afterAll(disconnectTestDb);
function token(row: any) { return jwt.sign({ scope: 'cashier', userType: 'cashier', cashierId: String(row._id), permissions: CASHIER_PERMISSIONS, isSuperAdmin: row.scope === 'platform', vendorId: String(row.vendorId), eventId: String(row.eventId), fullName: row.fullName }, secret); }
async function seed() {
  const vendorId = new mongoose.Types.ObjectId(); const now = new Date();
  const event = await Event.create({ vendorId, name: 'Fest', venue: 'Venue', eventDate: now, startTime: now, endTime: now, currency: 'SZL', status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [] });
  const cashier = await Cashier.create({ fullName: 'Cashier One', loginCode: '4KZ801', pin: '123456', scope: 'organizer', vendorId, eventId: event._id });
  const collector = await Cashier.create({ fullName: 'Collector One', loginCode: '4KZ802', pin: '123456', scope: 'platform', grants: [OperatorGrant.COLLECT_CASH] });
  const wallet = await WalletService.ensureWalletForTicket({ ticketId: String(new mongoose.Types.ObjectId()), eventId: String(event._id) });
  await WalletService.topUpAtDesk({ walletId: String(wallet._id), eventId: String(event._id), amount: 10000, method: 'cash', recordedBy: String(cashier._id), recordedByType: 'Cashier', clientTxnId: 'cash' });
  await WalletService.topUpAtDesk({ walletId: String(wallet._id), eventId: String(event._id), amount: 90000, method: 'card', recordedBy: String(cashier._id), recordedByType: 'Cashier', clientTxnId: 'card' });
  const eventId = String(event._id), cashierToken = token(cashier), collectorToken = token(collector);
  const create = (amount = 8000, clientTxnId = 'pick1', t = collectorToken, cashierId = String(cashier._id)) => request(app).post('/api/cashier/cash-collections').set('Authorization', `Bearer ${t}`).send({ eventId, cashierId, amount, clientTxnId });
  const resolve = (id: string, decision = 'confirm', t = cashierToken, pin: string | undefined = '123456') => request(app).post(`/api/cashier/cash-collections/${id}/resolve`).set('Authorization', `Bearer ${t}`).send({ eventId, decision, pin });
  const desk = (t = cashierToken) => request(app).get(`/api/cashier/cash-desk?eventId=${eventId}`).set('Authorization', `Bearer ${t}`);
  return { vendorId, event, eventId, cashier, collector, wallet, cashierToken, collectorToken, create, resolve, desk };
}
it('only the cashier confirms, custody transfers once and card money is excluded', async () => {
  const s = await seed(); const pickup = (await s.create().expect(200)).body.data;
  expect((await s.desk().expect(200)).body.data).toMatchObject({ cashOnHand: 10000, collected: 0, collectorHeld: 0, pending: [expect.objectContaining({ collectorName: 'Collector One', amount: 8000 })] });
  await s.resolve(pickup._id, 'confirm', s.collectorToken).expect(403);
  await s.resolve(pickup._id).expect(200); await s.resolve(pickup._id).expect(200);
  expect((await s.desk()).body.data).toMatchObject({ cashOnHand: 2000, collected: 8000, pending: [] });
  expect((await s.desk(s.collectorToken)).body.data).toMatchObject({ collectorHeld: 8000 });
  expect(await LedgerEntry.countDocuments({ refType: 'cash_collection' })).toBe(2);
  expect(await LedgerService.floatBalance(s.eventId, FloatTag.CASH_DESK)).toBe(2000);
  expect(await LedgerService.floatBalance(s.eventId, FloatTag.COLLECTOR_CASH)).toBe(8000);
  expect(await LedgerService.floatBalance(s.eventId, FloatTag.CARD_DESK)).toBe(90000);
  expect(await LedgerService.floatBalance(s.eventId)).toBe(100000);
  expect((await LedgerEntry.find({ eventId: s.eventId }).lean()).reduce((n, row) => n + row.delta, 0)).toBe(0);
});
it('reject/cancel retain cash with the cashier; final states cannot be changed', async () => {
  const s = await seed(); const a = (await s.create()).body.data;
  await s.resolve(a._id, 'reject').expect(200); await s.resolve(a._id).expect(409);
  const b = (await s.create(4000, 'pick2')).body.data;
  await s.resolve(b._id, 'cancel').expect(403); await s.resolve(b._id, 'cancel', s.collectorToken).expect(200);
  expect((await s.desk()).body.data.cashOnHand).toBe(10000);
  expect(await LedgerEntry.countDocuments({ refType: 'cash_collection' })).toBe(0);
});
it('fresh live grants, assignment and no self-collection gate creation', async () => {
  const s = await seed(); await s.create(1000, 'self', s.collectorToken, String(s.collector._id)).expect(400);
  await s.create(1000, 'ungranted', s.cashierToken, String(s.collector._id)).expect(403);
  await Cashier.updateOne({ _id: s.collector._id }, { $set: { grants: [] } });
  await s.create().expect(403);
  await Cashier.updateOne({ _id: s.collector._id }, { $set: { grants: [OperatorGrant.COLLECT_CASH], scope: 'organizer', vendorId: new mongoose.Types.ObjectId(), eventId: new mongoose.Types.ObjectId() } });
  await s.create().expect(403);
});
it('two concurrent confirmations cannot collect the same cash twice', async () => {
  const s = await seed(); const a = (await s.create()).body.data, b = (await s.create(8000, 'pick2')).body.data;
  const results = await Promise.all([s.resolve(a._id), s.resolve(b._id)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect(await CashCollection.countDocuments({ status: 'confirmed' })).toBe(1);
  expect(await CashDeskService.totals(s.eventId, String(s.cashier._id))).toMatchObject({ cashOnHand: 2000, collected: 8000 });
});
it('cash-outs after a request are included in the confirmation check', async () => {
  const s = await seed(); const a = (await s.create()).body.data;
  await WalletService.withdrawCash({ walletId: String(s.wallet._id), eventId: s.eventId, amount: 5000, recordedBy: String(s.cashier._id), clientTxnId: 'out' });
  await s.resolve(a._id).expect(409);
  expect(await LedgerEntry.countDocuments({ refType: 'cash_collection' })).toBe(0);
});
it('idempotent collection retries validate the payload and oversized amounts refuse', async () => {
  const s = await seed(); const a = (await s.create()).body.data;
  expect((await s.create()).body.data._id).toBe(a._id);
  await s.create(7000).expect(409); await s.create(10001, 'large').expect(409); await s.create(-1, 'bad').expect(400);
  expect(await CashCollection.countDocuments()).toBe(1);
});
it('organiser report scopes events and shows both parties and all confirmed cash', async () => {
  const s = await seed(); const a = (await s.create()).body.data; await s.resolve(a._id).expect(200);
  const vendorToken = (id: string, permissions = [TicketsPermission.VIEW_REVENUE]) => jwt.sign({ app: 'tickets', userType: 'vendor', vendorId: id, permissions }, secret);
  const report = (t: string) => request(app).get(`/api/tickets/events/${s.eventId}/cash-collections`).set('Authorization', `Bearer ${t}`);
  await report(vendorToken(String(new mongoose.Types.ObjectId()))).expect(403);
  await report(vendorToken(String(s.vendorId), [])).expect(403);
  const data = (await report(vendorToken(String(s.vendorId))).expect(200)).body.data;
  expect(data).toMatchObject({ currency: 'SZL', cashOnHand: 2000, collectorHeld: 8000, pendingCount: 0, collectors: [expect.objectContaining({ fullName: 'Collector One', held: 8000 })] });
  expect(data.collections[0]).toMatchObject({ cashierName: 'Cashier One', collectorName: 'Collector One', status: 'confirmed', resolvedBy: String(s.cashier._id) });
});

it('cashier PIN is mandatory, failed guesses lock out and no cash moves', async () => {
  const s = await seed(); const a = (await s.create()).body.data;
  await s.resolve(a._id, 'confirm', s.cashierToken, '').expect(400);
  for (let i = 0; i < 5; i++) await s.resolve(a._id, 'confirm', s.cashierToken, '999999').expect(401);
  await s.resolve(a._id, 'confirm', s.cashierToken, '123456').expect(429);
  expect(await LedgerEntry.countDocuments({ refType: 'cash_collection' })).toBe(0);
  expect((await CashCollection.findById(a._id))?.status).toBe('pending');
});

it('removing staff does not hide their recorded cash from the report', async () => {
  const s = await seed(); const a = (await s.create()).body.data; await s.resolve(a._id).expect(200);
  await Cashier.deleteOne({ _id: s.cashier._id });
  const report = await (await import('@services/cashCollection.service')).CashCollectionService.report(s.eventId);
  expect(report.cashOnHand).toBe(2000);
  expect(report.cashiers).toContainEqual(expect.objectContaining({ fullName: 'Cashier One', isActive: false, cashOnHand: 2000 }));
});
