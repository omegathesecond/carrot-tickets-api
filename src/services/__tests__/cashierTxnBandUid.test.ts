// A cashier's History row must say WHICH band it was. bandUid lives on Wallet,
// not on WalletTopup/WalletWithdrawal, so listTransactions has to join — and
// it must stay null (never a placeholder) for a ticket-bound wallet.
import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { seedPublishedEvent } from '@/__tests__/helpers/fixtures';
import { CashierService } from '@services/cashier.service';
import { Wallet } from '@models/wallet.model';
import { WalletTopup } from '@models/walletTopup.model';
import { WalletWithdrawal } from '@models/walletWithdrawal.model';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const CASHIER = 'cashier-1';

async function bandWallet(eventId: string, bandUid: string) {
  return String((await Wallet.create({ eventId, bandUid, balance: 0, status: 'active' }))._id);
}

it('carries the band UID of the wallet each top-up belongs to', async () => {
  const { eventId } = await seedPublishedEvent({});
  const walletId = await bandWallet(String(eventId), '04A2B3C4D5E6F7');
  await WalletTopup.create({
    walletId, eventId, amount: 5000, method: 'cash', status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'a-1',
  });

  const { transactions } = await CashierService.listTransactions({ cashierId: CASHIER });

  expect(transactions).toHaveLength(1);
  expect(transactions[0]!.bandUid).toBe('04A2B3C4D5E6F7');
});

it('carries the band UID on withdrawals too', async () => {
  const { eventId } = await seedPublishedEvent({});
  const walletId = await bandWallet(String(eventId), '04FFEEDDCCBBAA');
  await WalletWithdrawal.create({
    walletId, eventId, amount: 1500, status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'w-1',
  });

  const { transactions } = await CashierService.listTransactions({ cashierId: CASHIER });

  expect(transactions[0]!.bandUid).toBe('04FFEEDDCCBBAA');
});

it('reports null — never a placeholder — for a ticket-bound wallet', async () => {
  const { eventId } = await seedPublishedEvent({});
  // walletSchema.pre('validate') (wallet.model.ts:168) refuses a wallet with
  // NEITHER a ticket nor a band, so a ticket-bound wallet must carry a
  // ticketId — that is exactly what makes bandUid null here.
  const walletId = String((await Wallet.create({
    eventId, ticketId: new mongoose.Types.ObjectId(), bandUid: null,
    balance: 0, status: 'active',
  }))._id);
  await WalletTopup.create({
    walletId, eventId, amount: 2000, method: 'cash', status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'a-2',
  });

  const { transactions } = await CashierService.listTransactions({ cashierId: CASHIER });

  expect(transactions[0]!.bandUid).toBeNull();
});

it('maps each row to its own band when a cashier served several', async () => {
  const { eventId } = await seedPublishedEvent({});
  const first = await bandWallet(String(eventId), 'AAAA1111');
  const second = await bandWallet(String(eventId), 'BBBB2222');
  await WalletTopup.create({
    walletId: first, eventId, amount: 1000, method: 'cash', status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'a-3',
  });
  await WalletTopup.create({
    walletId: second, eventId, amount: 2000, method: 'cash', status: 'completed',
    recordedBy: CASHIER, recordedByType: 'Cashier', clientTxnId: 'a-4',
  });

  const { transactions } = await CashierService.listTransactions({ cashierId: CASHIER });

  const byAmount = new Map(transactions.map((t) => [t.amount, t.bandUid]));
  expect(byAmount.get(1000)).toBe('AAAA1111');
  expect(byAmount.get(2000)).toBe('BBBB2222');
});
