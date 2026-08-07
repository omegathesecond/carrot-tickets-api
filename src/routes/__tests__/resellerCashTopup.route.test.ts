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
import { WalletService } from '@services/wallet.service';

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
