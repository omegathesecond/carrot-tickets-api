import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { WalletService } from '@services/wallet.service';
import { MerchantService } from '@services/merchant.service';
import { ReconciliationService } from '@services/reconciliation.service';
import { Wallet } from '@models/wallet.model';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import mongoose from 'mongoose';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

// Reconciliation invariant (cashless spec §3) after a MIX of top-ups (credits)
// and merchant tap-to-pay charges (debits) on the same event — proves
// MerchantService.charge's postings are as balanced and internally
// consistent as WalletService.topUpCash's, not just individually correct in
// isolation.
it('shows no drift after a mix of top-ups and merchant charges, including a declined (rejected) charge', async () => {
  const eventId = new mongoose.Types.ObjectId();

  const w1 = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), status: 'active' });
  const w2 = await Wallet.create({ eventId, ticketId: new mongoose.Types.ObjectId(), status: 'active' });

  const merchantA = await Merchant.create({ name: 'Merchant A', eventId, commissionPercent: 10 });
  const merchantB = await Merchant.create({ name: 'Merchant B', eventId, commissionPercent: 0 });
  const operatorA = await new MerchantOperator({
    fullName: 'Operator A', merchantId: merchantA._id, eventId, loginCode: '4KZ9P1', pin: '111111',
  }).save();
  const operatorB = await new MerchantOperator({
    fullName: 'Operator B', merchantId: merchantB._id, eventId, loginCode: '4KZ9P2', pin: '222222',
  }).save();

  // Top-ups: wallet 1 gets 2000, wallet 2 gets 1500.
  await WalletService.topUpCash({ walletId: String(w1._id), eventId: String(eventId), amount: 2000, recordedBy: 'op1', clientTxnId: 't1' });
  await WalletService.topUpCash({ walletId: String(w2._id), eventId: String(eventId), amount: 1500, recordedBy: 'op1', clientTxnId: 't2' });

  // Charges: merchant A charges wallet 1 twice (with commission), merchant B
  // charges wallet 2 once (no commission).
  await MerchantService.charge({
    merchantId: String(merchantA._id), merchantOperatorId: String(operatorA._id), operatorName: operatorA.fullName,
    eventId: String(eventId), walletId: String(w1._id),
    bandUid: 'aa', amount: 500, clientTxnId: 'c1',
  });
  await MerchantService.charge({
    merchantId: String(merchantA._id), merchantOperatorId: String(operatorA._id), operatorName: operatorA.fullName,
    eventId: String(eventId), walletId: String(w1._id),
    bandUid: 'aa', amount: 300, clientTxnId: 'c2',
  });
  await MerchantService.charge({
    merchantId: String(merchantB._id), merchantOperatorId: String(operatorB._id), operatorName: operatorB.fullName,
    eventId: String(eventId), walletId: String(w2._id),
    bandUid: 'bb', amount: 1000, clientTxnId: 'c3',
  });

  // A DECLINED charge (insufficient balance) must leave zero trace — proving
  // the reconciliation invariant holds specifically BECAUSE nothing was
  // written on decline, not by coincidence.
  await expect(
    MerchantService.charge({
      merchantId: String(merchantA._id), merchantOperatorId: String(operatorA._id), operatorName: operatorA.fullName,
      eventId: String(eventId), walletId: String(w1._id),
      bandUid: 'aa', amount: 100_000, clientTxnId: 'c-declined',
    }),
  ).rejects.toMatchObject({ reason: 'insufficient_balance' });

  // Wallet 1: 2000 - 500 - 300 = 1200. Wallet 2: 1500 - 1000 = 500.
  const w1After = await Wallet.findById(w1._id).lean();
  const w2After = await Wallet.findById(w2._id).lean();
  expect(w1After!.balance).toBe(1200);
  expect(w2After!.balance).toBe(500);

  const invariant = await ReconciliationService.checkInvariant(String(eventId));
  expect(invariant.ok).toBe(true);
  expect(invariant.drift).toBe(0);
  // Float is untouched by charges (money already in custody just changes who
  // it's owed to) — float should equal the sum of top-ups only.
  expect(invariant.float).toBe(3500);
  expect(invariant.walletsOwed).toBe(1700); // 1200 + 500
  expect(invariant.merchantsOwed).toBe(720 + 1000); // A: (500+300)-fee(80)=720 net; B: 1000 net, 0 fee
  expect(invariant.feesEarned).toBe(80); // 10% of 800 charged through merchant A

  const integrity = await ReconciliationService.checkJournalIntegrity(String(eventId));
  expect(integrity.ok).toBe(true);
  expect(integrity.unbalancedTxnIds).toEqual([]);

  const walletBalances = await ReconciliationService.checkWalletBalances(String(eventId));
  expect(walletBalances.ok).toBe(true);
  expect(walletBalances.drifted).toEqual([]);
  expect(walletBalances.invariantViolations).toEqual([]);
});
