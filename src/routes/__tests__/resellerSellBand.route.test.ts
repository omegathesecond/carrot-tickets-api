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
import { WalletService } from '@services/wallet.service';

beforeAll(connectLedgerTestDb, 60000); afterEach(clearTestDb); afterAll(disconnectTestDb);

// createSale looks the reseller up by id (Reseller.findById), so resellerId
// must be real (seedReseller). operatorId is only ever used as the TicketSale
// `soldBy` ObjectId ref — never looked up — so a fixed valid ObjectId string
// is enough (mirrors resellerSale.service.test.ts). seedReseller() does NOT
// return an operatorId (see fixtures.ts), unlike the brief's sketch.
const OPERATOR_ID = '64b000000000000000000001';

async function setup(opts: { cashless?: boolean; capacity?: number; permissions?: ResellerPermission[] } = {}) {
  const { cashless = true, capacity, permissions = [ResellerPermission.SELL_TICKETS, ResellerPermission.CASH_TOPUP] } = opts;
  const { eventId, ticketTypeId } = await seedPublishedEvent(capacity !== undefined ? { capacity } : {});
  await Event.updateOne({ _id: eventId }, { $set: { cashless } });
  const { resellerId, hubId } = await seedReseller();
  const token = jwt.sign(
    { scope: 'reseller', resellerId, hubId, operatorId: OPERATOR_ID, role: ResellerRole.OPERATOR, permissions },
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
  const { eventId, ticketTypeId, token } = await setup({ cashless: false });
  const res = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 0, clientTxnId: 'sb-400' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cashless/i);
});

it('maps a sold-out ticket type to 400, not 500 (createSale business error)', async () => {
  const { eventId, ticketTypeId, token } = await setup({ capacity: 1 });
  // Directly mark the sole ticket as already sold, so checkTicketAvailability
  // reports 0 remaining without going through a full purchase flow.
  await Event.updateOne({ _id: eventId }, { $set: { 'ticketTypes.0.sold': 1 } });
  const res = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 0, clientTxnId: 'sb-soldout' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/available/i);
  // Nothing was minted for a rejected sale.
  expect(await Ticket.countDocuments({ eventId })).toBe(0);
});

it('403s when cashAmount > 0 but the token lacks CASH_TOPUP', async () => {
  const { eventId, ticketTypeId, token } = await setup({ permissions: [ResellerPermission.SELL_TICKETS] });
  const res = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 500, clientTxnId: 'sb-403' });
  expect(res.status).toBe(403);
  // Nothing was minted — the permission gate runs before createBandSale.
  expect(await Ticket.countDocuments({ eventId })).toBe(0);
});

/**
 * Fix round 1 (review finding 1, critical): the idempotency record used to be
 * written only AFTER the whole orchestration succeeded, so a failure between
 * minting the ticket and finishing (bindBand/topUpCash throwing) left nothing
 * to resume from — a retry with the SAME clientTxnId re-ran createSale and
 * minted a SECOND ticket+wallet. This mirrors the reviewer's exact repro:
 * force topUpCash to fail once, retry with the same clientTxnId, and assert
 * exactly one Ticket/Wallet exist and the retry completes the sale.
 */
it('resumes after a mid-flow failure without double-issuing a ticket (same clientTxnId retry)', async () => {
  const { eventId, ticketTypeId, token } = await setup();
  const body = { eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 500, clientTxnId: 'sb-resume' };

  const topUpSpy = jest.spyOn(WalletService, 'topUpCash').mockRejectedValueOnce(new Error('simulated topUpCash failure'));
  try {
    const first = await request(app).post('/api/reseller/sales/sell-band').set('Authorization', `Bearer ${token}`).send(body);
    expect(first.status).toBe(500); // the mocked failure is an unexpected fault, not a business error

    // The ticket + wallet + band bind already happened before the mocked
    // topUpCash threw — confirm the retry does NOT mint a second of either.
    const second = await request(app).post('/api/reseller/sales/sell-band').set('Authorization', `Bearer ${token}`).send(body);
    expect(second.status).toBe(201);
    expect(second.body.data.wallet.bandUid).toBe('04a22b1c3d4e5f');
    expect(second.body.data.wallet.balance).toBe(500);
  } finally {
    topUpSpy.mockRestore();
  }

  expect(await Ticket.countDocuments({ eventId })).toBe(1);
  const wallets = await Wallet.find({ eventId }).lean();
  expect(wallets.length).toBe(1);
  expect(wallets[0]!.balance).toBe(500);
  expect(wallets[0]!.bandUid).toBe('04a22b1c3d4e5f');
});

/**
 * FIX 1 (idempotency scoped to owner): clientTxnId used to be GLOBALLY unique
 * on ResellerBandSale, so two DIFFERENT resellers reusing the same clientTxnId
 * collided — the loser's E11000-recovery found and could replay the FIRST
 * reseller's sale, leaking that reseller's ticket+wallet (and its cash top-up
 * via the shared `${clientTxnId}:topup` id). With the compound unique
 * {resellerId, clientTxnId} (+ the wallet-scoped WalletTopup index) each
 * reseller mints its OWN ticket+wallet and neither receives the other's.
 */
it('two resellers reusing the same clientTxnId each mint their OWN ticket+wallet (no leak)', async () => {
  const { eventId, ticketTypeId, token: tokenA } = await setup();

  // Second reseller on the SAME cashless event, with its own token.
  const { resellerId: resellerB, hubId: hubB } = await seedReseller();
  const tokenB = jwt.sign(
    {
      scope: 'reseller', resellerId: resellerB, hubId: hubB, operatorId: OPERATOR_ID,
      role: ResellerRole.OPERATOR,
      permissions: [ResellerPermission.SELL_TICKETS, ResellerPermission.CASH_TOPUP],
    },
    JWT_SECRET,
  );
  const shared = 'shared-sb-ctx';

  const resA = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ eventId, ticketTypeId, bandUid: '04a22b1c3d4e5f', cashAmount: 500, clientTxnId: shared });
  expect(resA.status).toBe(201);
  expect(resA.body.data.wallet.bandUid).toBe('04a22b1c3d4e5f');
  expect(resA.body.data.wallet.balance).toBe(500);

  const resB = await request(app).post('/api/reseller/sales/sell-band')
    .set('Authorization', `Bearer ${tokenB}`)
    .send({ eventId, ticketTypeId, bandUid: '04b33c2d4e5f60', cashAmount: 700, clientTxnId: shared });
  expect(resB.status).toBe(201);
  // Reseller B's OWN band + balance — NOT reseller A's sale replayed back.
  expect(resB.body.data.wallet.bandUid).toBe('04b33c2d4e5f60');
  expect(resB.body.data.wallet.balance).toBe(700);
  expect(resB.body.data.ticket._id).not.toBe(resA.body.data.ticket._id);

  // Two distinct tickets + wallets on the event — neither reseller got the other's.
  expect(await Ticket.countDocuments({ eventId })).toBe(2);
  const wallets = await Wallet.find({ eventId }).lean();
  expect(wallets.length).toBe(2);
  expect(wallets.map((w) => w.bandUid).sort()).toEqual(['04a22b1c3d4e5f', '04b33c2d4e5f60']);
});
