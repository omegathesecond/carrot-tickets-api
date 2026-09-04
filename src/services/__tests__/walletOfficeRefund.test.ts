import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Wallet } from '@models/wallet.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';
import { LedgerEntry } from '@models/ledgerEntry.model';
import { WalletService } from '@services/wallet.service';
import { FloatTag } from '@interfaces/ledger.interface';

const EVENT = new mongoose.Types.ObjectId();

const wallet = () =>
  Wallet.create({
    eventId: EVENT, ticketId: new mongoose.Types.ObjectId(), bandUid: 'UID1',
    balance: 10000, cashFundedBalance: 10000, status: 'active',
  });

describe('office cash refund', () => {
  // Transactions: this path uses withTransaction, so it needs the replica set.
  beforeAll(connectLedgerTestDb); afterEach(clearTestDb); afterAll(disconnectTestDb);

  it('records the refund, moves the balance and posts a balanced pair', async () => {
    const w = await wallet();

    const { wallet: after, withdrawal } = await WalletService.withdrawCash({
      walletId: String(w._id), eventId: String(EVENT), amount: 4000,
      recordedBy: 'vendor-user-1', clientTxnId: 'refund-1',
      method: 'office_cash', recordedByType: 'Vendor', floatTag: FloatTag.OFFICE,
    });

    expect(after.balance).toBe(6000);
    expect(withdrawal.method).toBe('office_cash');

    const entries = await LedgerEntry.find({ refId: 'refund-1' }).lean();
    expect(entries.reduce((s, e: any) => s + e.delta, 0)).toBe(0);
    expect(entries.find((e: any) => e.accountType === 'float')!.tag).toBe('office');
  });

  it('is idempotent on a retry of the same clientTxnId', async () => {
    const w = await wallet();
    const args = {
      walletId: String(w._id), eventId: String(EVENT), amount: 4000,
      recordedBy: 'vendor-user-1', clientTxnId: 'refund-2',
      method: 'office_cash' as const, recordedByType: 'Vendor' as const, floatTag: FloatTag.OFFICE,
    };

    await WalletService.withdrawCash(args);
    const second = await WalletService.withdrawCash(args);

    expect(second.wallet.balance).toBe(6000);
    expect(await WalletWithdrawal.countDocuments({ clientTxnId: 'refund-2' })).toBe(1);
  });

  it('declines a refund larger than the balance, leaving everything untouched', async () => {
    const w = await wallet();

    await expect(
      WalletService.withdrawCash({
        walletId: String(w._id), eventId: String(EVENT), amount: 999999,
        recordedBy: 'vendor-user-1', clientTxnId: 'refund-3',
        method: 'office_cash', recordedByType: 'Vendor', floatTag: FloatTag.OFFICE,
      }),
    ).rejects.toThrow(/insufficient/i);

    expect((await Wallet.findById(w._id))!.balance).toBe(10000);
    expect(await LedgerEntry.countDocuments({ refId: 'refund-3' })).toBe(0);
  });

  it('still behaves as a cash-desk withdrawal when the new options are omitted', async () => {
    const w = await wallet();

    const { withdrawal } = await WalletService.withdrawCash({
      walletId: String(w._id), eventId: String(EVENT), amount: 1000,
      recordedBy: 'cashier-1', clientTxnId: 'cashout-1',
    });

    expect(withdrawal.method).toBe('cash');
    expect(withdrawal.recordedByType).toBe('Cashier');
    const float = await LedgerEntry.findOne({ refId: 'cashout-1', accountType: 'float' }).lean();
    expect((float as any).tag).toBe('cash_desk');
  });
});
