import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { Ticket } from '@models/ticket.model';
import { BandBinding } from '@models/bandBinding.model';
import { WalletTopup } from '@models/walletTopup.model';
import { TagReportService } from '@services/tagReport.service';

const EVENT = new mongoose.Types.ObjectId();
const VENDOR = new mongoose.Types.ObjectId();

async function walletFor(name: string, bandUid: string | null) {
  const ticket = await Ticket.create({
    eventId: EVENT, vendorId: VENDOR, ticketType: 'General', price: 0,
    customerName: name, customerPhone: '+26876000000',
  } as any);
  return Wallet.create({
    eventId: EVENT, ticketId: ticket._id, bandUid,
    balance: 5000, cashFundedBalance: 5000, status: 'active',
  });
}

describe('TagReportService.detail', () => {
  beforeAll(connectTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('returns null for a wallet on another event rather than leaking it', async () => {
    const w = await walletFor('Thandi', 'UID1');
    const detail = await TagReportService.detail(String(new mongoose.Types.ObjectId()), String(w._id));
    expect(detail).toBeNull();
  });

  it('lists the binding history newest first, with who bound it and why it was released', async () => {
    const w = await walletFor('Thandi', 'UID2');
    await BandBinding.create({
      walletId: w._id, eventId: EVENT, bandUid: 'UID1',
      boundAt: new Date('2026-08-01T10:00:00Z'), boundBy: 'gate-op-1',
      unboundAt: new Date('2026-08-01T18:00:00Z'), unboundReason: 'lost at the bar',
    });
    await BandBinding.create({
      walletId: w._id, eventId: EVENT, bandUid: 'UID2',
      boundAt: new Date('2026-08-01T18:05:00Z'), boundBy: 'gate-op-2',
    });

    const detail = await TagReportService.detail(String(EVENT), String(w._id));

    expect(detail!.bindings.map((b) => b.bandUid)).toEqual(['UID2', 'UID1']);
    expect(detail!.bindings[1]).toMatchObject({
      unboundReason: 'lost at the bar', boundBy: 'gate-op-1',
    });
    expect(detail!.bindings[0]!.unboundAt).toBeNull();
  });

  it('keeps two wallets that shared a UID apart', async () => {
    // A UID recycled between attendees must not merge their histories.
    const first = await walletFor('First Holder', null);
    const second = await walletFor('Second Holder', 'SHARED');
    await BandBinding.create({
      walletId: first._id, eventId: EVENT, bandUid: 'SHARED',
      boundAt: new Date('2026-08-01T10:00:00Z'), unboundAt: new Date('2026-08-01T12:00:00Z'),
    });
    await BandBinding.create({
      walletId: second._id, eventId: EVENT, bandUid: 'SHARED',
      boundAt: new Date('2026-08-01T12:05:00Z'),
    });

    const a = await TagReportService.detail(String(EVENT), String(first._id));
    const b = await TagReportService.detail(String(EVENT), String(second._id));

    expect(a!.bindings).toHaveLength(1);
    expect(b!.bindings).toHaveLength(1);
    expect(a!.holder.name).toBe('First Holder');
    expect(b!.holder.name).toBe('Second Holder');
  });

  it('includes top-ups in the movement history', async () => {
    const w = await walletFor('Thandi', 'UID3');
    await WalletTopup.create({
      walletId: w._id, eventId: EVENT, amount: 5000, method: 'cash',
      status: 'completed', recordedBy: 'cashier-1', recordedByType: 'Cashier',
      clientTxnId: 'txn-1',
    });

    const detail = await TagReportService.detail(String(EVENT), String(w._id));

    expect(detail!.movements).toEqual([
      expect.objectContaining({ kind: 'topup', amount: 5000 }),
    ]);
  });
});
