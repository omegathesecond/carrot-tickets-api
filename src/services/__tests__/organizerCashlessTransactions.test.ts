import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';
import { BandBinding } from '@models/bandBinding.model';
import { WalletTopup } from '@models/walletTopup.model';
import { MerchantCharge } from '@models/merchantCharge.model';
import { Cashier } from '@models/cashier.model';
import { OrganizerCashlessService } from '@services/organizerCashless.service';

const EVENT = new mongoose.Types.ObjectId();
const VENDOR = new mongoose.Types.ObjectId();
const MERCHANT = new mongoose.Types.ObjectId();

const at = (iso: string) => new Date(iso);

async function walletWithTag(bandUid: string | null) {
  const ticket = await Ticket.create({
    eventId: EVENT, vendorId: VENDOR, ticketType: 'General', price: 0,
    customerName: 'Sipho Nkosi', customerPhone: '+26876001234',
  } as any);
  return Wallet.create({
    eventId: EVENT, ticketId: ticket._id, bandUid,
    balance: 5000, cashFundedBalance: 0, status: 'active',
  });
}

async function topup(walletId: mongoose.Types.ObjectId, over: Record<string, unknown> = {}) {
  return WalletTopup.create({
    walletId, eventId: EVENT, amount: 5000, method: 'cash', status: 'completed',
    recordedBy: String(new mongoose.Types.ObjectId()), recordedByType: 'Cashier',
    clientTxnId: 'ctx-' + Math.random().toString(36).slice(2), ...over,
  });
}

describe('OrganizerCashlessService.transactions — the organizer-facing columns', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('carries the reference and status of every row, so a query can be traced', async () => {
    const wallet = await walletWithTag('04AABBCC');
    await topup(wallet._id as mongoose.Types.ObjectId, { clientTxnId: 'desk-0001' });

    const { transactions } = await OrganizerCashlessService.transactions({ eventId: String(EVENT) });

    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.ref).toBe('desk-0001');
    expect(transactions[0]!.status).toBe('completed');
  });

  it('shows the tag that was on the wallet AT THE TIME, not the one on it now', async () => {
    const wallet = await walletWithTag('04NEWTAG');
    // Registered on the old tag, reissued onto the new one at 20:00.
    await BandBinding.create({
      walletId: wallet._id, eventId: EVENT, bandUid: '04OLDTAG',
      boundAt: at('2026-08-19T17:00:00Z'), unboundAt: at('2026-08-19T20:00:00Z'),
    });
    await BandBinding.create({
      walletId: wallet._id, eventId: EVENT, bandUid: '04NEWTAG', boundAt: at('2026-08-19T20:00:00Z'),
    });
    await topup(wallet._id as mongoose.Types.ObjectId, { createdAt: at('2026-08-19T18:00:00Z') });
    await topup(wallet._id as mongoose.Types.ObjectId, { createdAt: at('2026-08-19T21:00:00Z') });

    const { transactions } = await OrganizerCashlessService.transactions({ eventId: String(EVENT) });

    const tags = transactions.map((t: any) => t.tagUid);
    expect(tags).toEqual(['04NEWTAG', '04OLDTAG']); // newest first
  });

  it('takes a purchase tag from the charge itself — the UID it was tapped with', async () => {
    const wallet = await walletWithTag('04AABBCC');
    await MerchantCharge.create({
      merchantId: MERCHANT, merchantOperatorId: new mongoose.Types.ObjectId(), eventId: EVENT,
      walletId: wallet._id, bandUid: '04AABBCC', amount: 2500, fee: 0, netAmount: 2500,
      clientTxnId: 'bar-77', status: 'completed', staffName: 'Bar Betty',
    });

    const { transactions } = await OrganizerCashlessService.transactions({ eventId: String(EVENT) });

    expect(transactions[0]!.tagUid).toBe('04AABBCC');
    expect(transactions[0]!.ref).toBe('bar-77');
  });

  it('finds every movement of a tag by any UID it has ever carried', async () => {
    const reissued = await walletWithTag('04NEWTAG');
    await BandBinding.create({
      walletId: reissued._id, eventId: EVENT, bandUid: '04OLDTAG',
      boundAt: at('2026-08-19T17:00:00Z'), unboundAt: at('2026-08-19T20:00:00Z'),
    });
    await topup(reissued._id as mongoose.Types.ObjectId, { createdAt: at('2026-08-19T18:00:00Z') });

    const other = await walletWithTag('04OTHER1');
    await topup(other._id as mongoose.Types.ObjectId);

    // The organizer types the number printed on the plastic they are holding —
    // the OLD one, which no wallet carries any more.
    const { transactions } = await OrganizerCashlessService.transactions({
      eventId: String(EVENT), tagUid: '04oldtag',
    });

    expect(transactions).toHaveLength(1);
    expect(String((transactions[0] as any).walletId)).toBe(String(reissued._id));
  });

  it('returns an empty page for a UID never seen at this event, not the whole log', async () => {
    const wallet = await walletWithTag('04AABBCC');
    await topup(wallet._id as mongoose.Types.ObjectId);

    const page = await OrganizerCashlessService.transactions({ eventId: String(EVENT), tagUid: 'NOPE' });

    expect(page.transactions).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('still names the actor behind each row', async () => {
    const cashier = await Cashier.create({
      fullName: 'Desk Dumi', scope: 'organizer', vendorId: VENDOR, eventId: EVENT,
      loginCode: '910001', pin: '123456',
    } as any);
    const wallet = await walletWithTag('04AABBCC');
    await topup(wallet._id as mongoose.Types.ObjectId, { recordedBy: String(cashier._id), recordedByType: 'Cashier' });

    const { transactions } = await OrganizerCashlessService.transactions({ eventId: String(EVENT) });

    expect(transactions[0]!.actorName).toBe('Desk Dumi');
  });
});
