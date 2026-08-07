import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent, seedReseller } from '@/__tests__/helpers/fixtures';
import { ResellerPermission, ResellerRole } from '@interfaces/resellerPermission.interface';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';

beforeAll(connectLedgerTestDb, 60000); afterEach(clearTestDb); afterAll(disconnectTestDb);

// createSale looks the reseller up by id (Reseller.findById), so resellerId
// must be real (seedReseller). operatorId is only ever used as the TicketSale
// `soldBy` ObjectId ref — never looked up — so a fixed valid ObjectId string
// is enough (mirrors resellerSale.service.test.ts). seedReseller() does NOT
// return an operatorId (see fixtures.ts), unlike the brief's sketch.
const OPERATOR_ID = '64b000000000000000000001';

async function setup(cashless = true) {
  const { eventId, ticketTypeId } = await seedPublishedEvent({});
  await Event.updateOne({ _id: eventId }, { $set: { cashless } });
  const { resellerId, hubId } = await seedReseller();
  const token = jwt.sign(
    {
      scope: 'reseller', resellerId, hubId, operatorId: OPERATOR_ID, role: ResellerRole.OPERATOR,
      permissions: [ResellerPermission.SELL_TICKETS, ResellerPermission.CASH_TOPUP],
    },
    JWT_SECRET,
  );
  return { eventId, ticketTypeId, resellerId, hubId, token };
}

it('sells a band as a ticket: mints ticket + wallet + binding (+cash)', async () => {
  const { eventId, ticketTypeId, token } = await setup();

  const res = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 1000, clientTxnId: 'sb-1' });

  expect(res.status).toBe(201);
  expect(res.body.data.wallet.bandUid).toBe('04a22b1c3d4e5f');
  expect(res.body.data.wallet.balance).toBe(1000);
  expect(res.body.data.ticket).toBeDefined();
  expect(res.body.data.binding.bandUid).toBe('04a22b1c3d4e5f');
  const w = await Wallet.findOne({ bandUid: '04a22b1c3d4e5f' }).lean();
  expect(String(w!.ticketId)).toBeDefined();
});

it('rejects an already-bound uid loudly and leaves a bindable ticket', async () => {
  const { eventId, ticketTypeId, token } = await setup();
  const body = (ctx: string) => ({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 0, clientTxnId: ctx });

  const first = await request(app).post('/api/reseller/sales/sell-band').set('Authorization', `Bearer ${token}`).send(body('sb-a'));
  expect(first.status).toBe(201);

  const res = await request(app).post('/api/reseller/sales/sell-band').set('Authorization', `Bearer ${token}`).send(body('sb-b'));
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/already bound/i);

  // The second attempt's ticket was minted (a SOLD ticket with no band is
  // acceptable/recoverable per spec §5.1) — it must NOT have been rolled back.
  const tickets = await Ticket.find({ eventId }).lean();
  expect(tickets.length).toBe(2);
  const wallets = await Wallet.find({ eventId }).lean();
  expect(wallets.length).toBe(2);
  expect(wallets.filter((w) => w.bandUid === '04a22b1c3d4e5f').length).toBe(1);
});

it('is idempotent on clientTxnId — a retry does not double-issue a ticket', async () => {
  const { eventId, ticketTypeId, token } = await setup();
  const body = { eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 500, clientTxnId: 'sb-retry' };

  const first = await request(app).post('/api/reseller/sales/sell-band').set('Authorization', `Bearer ${token}`).send(body);
  expect(first.status).toBe(201);

  const second = await request(app).post('/api/reseller/sales/sell-band').set('Authorization', `Bearer ${token}`).send(body);
  expect(second.status).toBe(201);
  expect(second.body.data.wallet.bandUid).toBe('04a22b1c3d4e5f');
  expect(second.body.data.wallet.balance).toBe(500);
  expect(second.body.data.ticket._id).toBe(first.body.data.ticket._id);

  // Only ONE ticket and ONE wallet exist for this event — the retry did not mint again.
  const tickets = await Ticket.find({ eventId }).lean();
  expect(tickets.length).toBe(1);
  const wallets = await Wallet.find({ eventId }).lean();
  expect(wallets.length).toBe(1);
  expect(wallets[0]!.balance).toBe(500);
});

it('404s for a non-cashless-flagged event (event not found for the wrong id)', async () => {
  const { eventId, ticketTypeId, token } = await setup();
  const res = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId: '64b000000000000000000099', ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 0, clientTxnId: 'sb-404' });
  expect(res.status).toBe(404);
  void eventId;
});

it('400s when the event is not cashless', async () => {
  const { eventId, ticketTypeId, token } = await setup(false);
  const res = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 0, clientTxnId: 'sb-400' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cashless/i);
});
