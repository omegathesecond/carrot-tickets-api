import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { ResellerPermission, ResellerRole } from '@interfaces/resellerPermission.interface';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { EventStatus } from '@interfaces/event.interface';
import { WalletService, MAX_TOPUP_CENTS } from '@services/wallet.service';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { WalletTopup } from '@models/walletTopup.model';

beforeAll(connectLedgerTestDb, 60000); afterEach(clearTestDb); afterAll(disconnectTestDb);

const token = (perms = [ResellerPermission.CASH_TOPUP], over = {}) => jwt.sign({
  scope: 'reseller', resellerId: 'r1', hubId: null, operatorId: 'op1',
  role: ResellerRole.OPERATOR, permissions: perms, ...over,
}, JWT_SECRET);

async function seedBoundBand(cashless = true) {
  const { eventId, vendorId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless } });
  const t = await Ticket.create({ eventId, vendorId, ticketType: 'General', price: 100, status: TicketStatus.SOLD });
  const w = await WalletService.ensureWalletForTicket({ ticketId: String(t._id), eventId: String(eventId) });
  await enrolTags(eventId, '04a22b1c3d4e5f');
  await WalletService.bindBand(String(w._id), '04a22b1c3d4e5f', 'op1');
  return { eventId: String(eventId), bandUid: '04a22b1c3d4e5f' };
}

it('tops up a wallet by band uid', async () => {
  const { eventId, bandUid } = await seedBoundBand();
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ bandUid, eventId, amount: 500, clientTxnId: 'c1' });
  expect(res.status).toBe(200);
  expect(res.body.data.wallet.balance).toBe(500);
});

it('rejects a non-cashless event with 400', async () => {
  const { eventId, bandUid } = await seedBoundBand(false);
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ bandUid, eventId, amount: 500, clientTxnId: 'c2' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cashless/i);
});

it('rejects a token missing CASH_TOPUP with 403', async () => {
  const { eventId, bandUid } = await seedBoundBand();
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token([ResellerPermission.SELL_TICKETS])}`)
    .send({ bandUid, eventId, amount: 500, clientTxnId: 'c3' });
  expect(res.status).toBe(403);
});

it('is idempotent on clientTxnId', async () => {
  const { eventId, bandUid } = await seedBoundBand();
  const body = { bandUid, eventId, amount: 500, clientTxnId: 'dup' };
  await request(app).post('/api/reseller/wallets/cash-topup').set('Authorization', `Bearer ${token()}`).send(body);
  const res = await request(app).post('/api/reseller/wallets/cash-topup').set('Authorization', `Bearer ${token()}`).send(body);
  expect(res.status).toBe(200);
  expect(res.body.data.wallet.balance).toBe(500);
});

it('rejects a malformed ticketId with 400 (not a 500 from an unhandled CastError)', async () => {
  const { eventId } = await seedBoundBand();
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ ticketId: 'not-a-valid-object-id', eventId, amount: 500, clientTxnId: 'bad' });
  expect(res.status).toBe(400);
});

// FIX 1 (idempotency scoped to owner): the same clientTxnId used against TWO
// DIFFERENT wallets must credit EACH wallet its own amount — never replay the
// first wallet's row to the second caller (a cross-tenant leak + silent
// no-op). Two distinct WalletTopup rows must exist for the shared id.
it('credits each wallet independently when two DIFFERENT wallets reuse the same clientTxnId', async () => {
  const a = await seedBoundBand(); // event A → wallet A
  const b = await seedBoundBand(); // event B → wallet B (same band uid, different event)
  const shared = 'shared-ctx';

  const resA = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ bandUid: a.bandUid, eventId: a.eventId, amount: 500, clientTxnId: shared });
  expect(resA.status).toBe(200);
  expect(resA.body.data.wallet.balance).toBe(500);

  const resB = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ bandUid: b.bandUid, eventId: b.eventId, amount: 700, clientTxnId: shared });
  expect(resB.status).toBe(200);
  // Wallet B's OWN credit — NOT wallet A's row replayed back at 500.
  expect(resB.body.data.wallet.balance).toBe(700);

  // One row per wallet for the shared id — proof neither leaked nor no-op'd.
  expect(await WalletTopup.countDocuments({ clientTxnId: shared })).toBe(2);
});

// FIX 4 (lifecycle guard): a cashless but CANCELLED (non-published) event must
// reject the top-up with 400, mirroring ResellerSaleService.createSale.
it('rejects a top-up against a cancelled (non-published) event with 400', async () => {
  const { eventId, bandUid } = await seedBoundBand();
  await Event.updateOne({ _id: eventId }, { $set: { status: EventStatus.CANCELLED } });
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ bandUid, eventId, amount: 500, clientTxnId: 'c-cancelled' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/published/i);
});

// FIX 5 (safety ceiling): an amount above MAX_TOPUP_CENTS is rejected with 400
// (Joi ceiling; also enforced defense-in-depth inside WalletService.topUpCash).
it('rejects an amount over the safety ceiling with 400', async () => {
  const { eventId, bandUid } = await seedBoundBand();
  const res = await request(app).post('/api/reseller/wallets/cash-topup')
    .set('Authorization', `Bearer ${token()}`)
    .send({ bandUid, eventId, amount: MAX_TOPUP_CENTS + 1, clientTxnId: 'c-ceiling' });
  expect(res.status).toBe(400);
});
