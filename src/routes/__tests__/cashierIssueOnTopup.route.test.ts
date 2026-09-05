// api/src/routes/__tests__/cashierIssueOnTopup.route.test.ts
//
// The cashier IS the entrance desk — she tops up and cashes out as people come
// in. Making her hand a blank tag to a separate register desk first is a queue
// at the door, so a cashier granted issue_tags turns a blank tag into a funded
// wallet in the one call the POS already makes.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Cashier } from '@models/cashier.model';
import { Event } from '@models/event.model';
import { Wallet } from '@models/wallet.model';
import { EventTag } from '@models/eventTag.model';
import { BandBinding } from '@models/bandBinding.model';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletService } from '@services/wallet.service';
import { EventStatus } from '@interfaces/event.interface';
import { CASHIER_PERMISSIONS, CashierPermission } from '@interfaces/cashier.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const TAG = '04a22b1c';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 700;

async function seedDesk(opts: { canIssue: boolean }) {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future, endTime: future,
    status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const cashier = await Cashier.create({
    fullName: 'Nandi', loginCode: `4KZ${seq++}`, pin: '222222',
    scope: 'organizer', vendorId, eventId: event._id,
  });
  const permissions = opts.canIssue
    ? [...CASHIER_PERMISSIONS, CashierPermission.ISSUE_TAGS]
    : CASHIER_PERMISSIONS;
  const token = jwt.sign({
    scope: 'cashier', userType: 'cashier', cashierId: String(cashier._id), role: 'cashier',
    permissions, isSuperAdmin: false, fullName: 'Nandi',
    vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { eventId: String(event._id), token, vendorId };
}

const topup = (token: string, eventId: string, body: Record<string, unknown>) =>
  request(app).post('/api/cashier/topup')
    .set('Authorization', `Bearer ${token}`)
    .send({ eventId, ...body });

describe('a granted cashier turns a blank tag into a funded wallet in one tap', () => {
  it('registers the tag, gives it a wallet and loads it', async () => {
    const { eventId, token } = await seedDesk({ canIssue: true });

    const res = await topup(token, eventId, { bandUid: TAG, amount: 3000, clientTxnId: 'x1' });

    expect(res.status).toBe(200);
    expect(res.body.data.newBalance).toBe(3000);

    const wallet = await Wallet.findOne({ eventId, bandUid: TAG });
    expect(wallet).not.toBeNull();
    expect(wallet!.ticketId).toBeUndefined();
    // In the register, so it works at the stalls and shows on Balances.
    expect(await EventTag.countDocuments({ eventId, bandUid: TAG, status: 'active' })).toBe(1);
    expect(await BandBinding.countDocuments({ eventId, bandUid: TAG })).toBe(1);
  });

  it('needs no extra grant — this is the cashier job, not a special power', async () => {
    // A cashier already moves money at this desk: she tops up, and on withdraw
    // she hands out CASH. Enrolling a blank tag is strictly less dangerous than
    // what the role does by default, so gating it behind a per-person grant
    // protected the smaller thing and put a second queue at the door.
    const { eventId, token } = await seedDesk({ canIssue: false });

    const res = await topup(token, eventId, { bandUid: TAG, amount: 3000, clientTxnId: 'x1' });

    expect(res.status).toBe(200);
    expect(res.body.data.newBalance).toBe(3000);
    expect(await EventTag.countDocuments({ eventId, bandUid: TAG, status: 'active' })).toBe(1);
  });

  it('is still bounded by the event she was hired for', async () => {
    // The loosening is about which CAPABILITY a cashier has, not about which
    // show she can touch — that guard is unchanged.
    const { token } = await seedDesk({ canIssue: false });
    const other = await seedDesk({ canIssue: false });

    const res = await topup(token, other.eventId, { bandUid: TAG, amount: 3000, clientTxnId: 'x9' });

    expect(res.status).toBe(403);
    expect(await Wallet.countDocuments({ eventId: other.eventId })).toBe(0);
  });

  it('does not re-register or double-charge on a POS retry', async () => {
    const { eventId, token } = await seedDesk({ canIssue: true });
    const body = { bandUid: TAG, amount: 3000, clientTxnId: 'same' };

    await topup(token, eventId, body);
    const retry = await topup(token, eventId, body);

    expect(retry.status).toBe(200);
    expect(retry.body.data.newBalance).toBe(3000);
    expect(await Wallet.countDocuments({ eventId })).toBe(1);
    expect(await EventTag.countDocuments({ eventId })).toBe(1);
    expect(await WalletTopup.countDocuments({ eventId })).toBe(1);
  });

  it('tops up a tag that already carries a ticket wallet without touching it', async () => {
    const { eventId, token } = await seedDesk({ canIssue: true });
    const ticketId = new mongoose.Types.ObjectId();
    const existing = await WalletService.ensureWalletForTicket({
      ticketId: String(ticketId), eventId,
    });
    await Wallet.updateOne({ _id: existing._id }, { $set: { bandUid: TAG } });

    const res = await topup(token, eventId, { bandUid: TAG, amount: 2000, clientTxnId: 'x2' });

    expect(res.status).toBe(200);
    const wallet = await Wallet.findById(existing._id);
    expect(wallet!.balance).toBe(2000);
    expect(String(wallet!.ticketId)).toBe(String(ticketId));
    expect(await Wallet.countDocuments({ eventId })).toBe(1);
  });

  it('still refuses a top-up with no band at all', async () => {
    const { eventId, token } = await seedDesk({ canIssue: true });
    const res = await topup(token, eventId, {
      ticketId: String(new mongoose.Types.ObjectId()), amount: 1000, clientTxnId: 'x3',
    });
    expect(res.status).toBe(404);
  });
});
