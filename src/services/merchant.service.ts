// api/src/services/merchant.service.ts
import mongoose from 'mongoose';
import { Wallet, IWallet } from '@models/wallet.model';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge, IMerchantCharge } from '@models/merchantCharge.model';
import { LedgerService } from '@services/ledger.service';
import { LedgerAccountType } from '@interfaces/ledger.interface';

/**
 * Safety ceiling on a single tap-to-pay charge, in minor units (cents):
 * R100,000. Mirrors WalletService.MAX_TOPUP_CENTS — an adjustable
 * defense-in-depth limit against ledger inflation from a fat-fingered or
 * malicious amount, enforced both in chargeSchema (Joi) and here, so a
 * caller that bypasses validation still cannot inflate a single charge.
 */
export const MAX_CHARGE_CENTS = 10_000_000;

/**
 * A tap-to-pay charge was DECLINED — the wallet was NOT debited, no ledger
 * postings were written, and no MerchantCharge row exists for this attempt.
 * Thrown instead of a plain Error so the controller can map it to 402
 * (payment declined) rather than 400 (bad request) or 500 (server fault).
 */
export class WalletDeclinedError extends Error {
  constructor(
    public readonly reason: 'insufficient_balance' | 'wallet_not_active' | 'wallet_not_found',
    message: string,
    public readonly currentBalance: number | null = null,
  ) {
    super(message);
    this.name = 'WalletDeclinedError';
  }
}

/**
 * Merchant tap-to-pay money movement (cashless spec) — DOES NOT mutate
 * `balance` outside this one atomic CAS. Same transaction shape as
 * WalletService.topUpCash (open session.withTransaction, atomic
 * aggregation-pipeline wallet update, LedgerService.post on the same
 * session, a durable record write, idempotent on clientTxnId including
 * E11000 recovery) but DEBITS the wallet instead of crediting it, and splits
 * the debit between the merchant and the platform fee.
 */
export class MerchantService {
  /**
   * Charge a tapped band's wallet on behalf of `merchantId` at `eventId`.
   *
   * Idempotent on `clientTxnId`, scoped to the OWNING merchant — mirrors
   * WalletTopup's {walletId, clientTxnId} scoping (see wallet.service.ts /
   * walletTopup.model.ts): a repeat call with the same id for the same
   * merchant returns the ORIGINAL outcome rather than charging twice, and the
   * same id used by a DIFFERENT merchant is a different, legitimate charge.
   *
   * A DECLINE (insufficient balance / inactive / missing wallet) throws
   * WalletDeclinedError and leaves the wallet, ledger, and MerchantCharge
   * collection completely untouched — nothing is written on a decline,
   * because the CAS guard and the decrement are the SAME atomic operation
   * (wallet.model.ts's documented CAS-debit pattern) and every write below it
   * only runs once that CAS has already succeeded.
   */
  static async charge(params: {
    merchantId: string;
    eventId: string;
    walletId: string;
    bandUid: string;
    amount: number;
    clientTxnId: string;
  }): Promise<{ wallet: IWallet; charge: IMerchantCharge }> {
    const { merchantId, eventId, walletId, bandUid, amount, clientTxnId } = params;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('amount must be a positive integer (cents)');
    }
    if (amount > MAX_CHARGE_CENTS) {
      throw new Error('amount exceeds the maximum allowed charge');
    }

    // Idempotency: if this clientTxnId already ran FOR THIS MERCHANT, return
    // the existing outcome.
    const existing = await MerchantCharge.findOne({ merchantId, clientTxnId });
    if (existing) {
      const w = await Wallet.findById(existing.walletId);
      if (!w) throw new Error('wallet not found');
      return { wallet: w, charge: existing };
    }

    const session = await mongoose.startSession();
    try {
      let out!: { wallet: IWallet; charge: IMerchantCharge };
      await session.withTransaction(async () => {
        // Merchant must exist and be active — a suspended merchant (or one
        // deleted after its JWT was issued) must not be able to charge even
        // with an otherwise-valid, unexpired token. commissionPercent is read
        // fresh here (it is NOT carried in the JWT) so a rate change takes
        // effect immediately rather than being pinned to whatever it was at
        // login time.
        const merchant = await Merchant.findById(merchantId).session(session);
        if (!merchant || merchant.status !== 'active') {
          throw new Error('merchant not found or not active');
        }

        // Atomic CAS debit: the guard (status active + sufficient balance)
        // and the decrement are the SAME operation, so no concurrent tap can
        // ever push the balance negative. cashFundedBalance is drawn down
        // first and floored at 0 via $max, mirroring topUpCash's pipeline
        // update and the CAS-debit pattern documented in wallet.model.ts.
        const wallet = await Wallet.findOneAndUpdate(
          { _id: walletId, eventId, status: 'active', balance: { $gte: amount } },
          [
            {
              $set: {
                balance: { $subtract: ['$balance', amount] },
                cashFundedBalance: { $max: [0, { $subtract: ['$cashFundedBalance', amount] }] },
              },
            },
          ],
          { new: true, session },
        );

        if (!wallet) {
          // DECLINE. Nothing has been written yet, so this re-read is purely
          // to report a true reason + current balance — the same pattern
          // WalletService.bindBand uses to explain an already-failed CAS.
          const fresh = await Wallet.findOne({ _id: walletId, eventId }).session(session);
          if (!fresh) throw new WalletDeclinedError('wallet_not_found', 'wallet not found', null);
          if (fresh.status !== 'active') {
            throw new WalletDeclinedError('wallet_not_active', 'wallet is not active', fresh.balance);
          }
          throw new WalletDeclinedError('insufficient_balance', 'insufficient balance', fresh.balance);
        }

        const commissionPercent = merchant.commissionPercent || 0;
        const fee = Math.floor((amount * commissionPercent) / 100);
        const net = amount - fee;

        await LedgerService.post({
          eventId,
          postings: [
            { account: { type: LedgerAccountType.WALLET, ref: walletId }, delta: amount },
            { account: { type: LedgerAccountType.MERCHANT, ref: merchantId }, delta: -net },
            ...(fee > 0 ? [{ account: { type: LedgerAccountType.FEES }, delta: -fee }] : []),
          ],
          refType: 'merchant_charge',
          refId: clientTxnId,
          session,
        });

        const [charge] = await MerchantCharge.create(
          [{ merchantId, eventId, walletId, bandUid, amount, fee, netAmount: net, clientTxnId, status: 'completed' }],
          { session },
        );
        if (!charge) throw new Error('merchant charge insert failed');

        out = { wallet, charge };
      });
      return out;
    } catch (e) {
      // Concurrent duplicate: the {merchantId, clientTxnId} unique index lost
      // the race — re-read the winner with the SAME scoped filter so we never
      // return a different merchant's row.
      if ((e as { code?: number })?.code === 11000) {
        const charge = await MerchantCharge.findOne({ merchantId, clientTxnId });
        const wallet = charge ? await Wallet.findById(charge.walletId) : null;
        if (charge && wallet) return { wallet, charge };
      }
      throw e;
    } finally {
      await session.endSession();
    }
  }
}
