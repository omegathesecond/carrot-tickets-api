import mongoose from 'mongoose';
import { MerchantCharge, IMerchantCharge } from '@models/merchantCharge.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { Merchant } from '@models/merchant.model';
import { Event } from '@models/event.model';
import { Wallet, IWallet } from '@models/wallet.model';
import { LedgerService } from '@services/ledger.service';
import { StockService } from '@services/stock.service';
import { StockAlertService } from '@services/stockAlert.service';
import { LedgerAccountType } from '@interfaces/ledger.interface';
import { StockMovementReason } from '@interfaces/stock.interface';
import { verifyOperatorPin } from '@utils/pinLockout.util';
import { normalizeBandUid } from '@utils/bandUid.util';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';

/** A full cancellation of a direct till sale. Stored amounts, never current
 * prices/commissions, undo all money legs together with any stock return. */
export class MerchantReversalService {
  static async reverse(params: { chargeId: string; eventId: string; merchantId: string; merchantOperatorId: string; pin: string; bandUid: string; reason: string; restock: boolean }) {
    const { chargeId, eventId, merchantId, merchantOperatorId, pin, restock } = params;
    const reason = params.reason.trim();
    if (![chargeId, eventId, merchantId, merchantOperatorId].every(id => HEX24.test(id)) || !/^\d{6}$/.test(pin) || reason.length < 3 || reason.length > 300 || typeof restock !== 'boolean') throw new HttpError(400, 'Sale, your PIN, a reason and stock choice are required');
    const bandUid = normalizeBandUid(params.bandUid);
    const query = { _id: chargeId, eventId, merchantId };
    const initial = await MerchantCharge.findOne(query);
    if (!initial) throw new HttpError(404, 'Sale not found for this stall');
    const operator = await MerchantOperator.findOne({ _id: merchantOperatorId, eventId, merchantId, isActive: true }).select('+pin');
    if (!operator) throw new HttpError(403, 'Vendor account is inactive or belongs to another stall');
    await verifyOperatorPin(MerchantOperator, operator, pin);

    const session = await mongoose.startSession();
    try {
      let result!: { charge: IMerchantCharge; wallet: IWallet };
      await session.withTransaction(async () => {
        const merchant = await Merchant.findOne({ _id: merchantId, eventId, status: 'active' }).session(session);
        const live = await MerchantOperator.findOne({ _id: merchantOperatorId, eventId, merchantId, isActive: true }).session(session);
        const event = await Event.findById(eventId).session(session);
        if (!merchant || !live || !event?.cashless) throw new HttpError(403, 'Vendor or cashless event is unavailable');
        const charge = await MerchantCharge.findOne(query).session(session);
        if (!charge) throw new HttpError(404, 'Sale not found for this stall');
        if (charge.bandUid !== bandUid) throw new HttpError(409, 'Tap the same band used for this sale');
        const wallet = await Wallet.findOne({ _id: charge.walletId, eventId, bandUid, status: 'active' }).session(session);
        if (!wallet) throw new HttpError(409, 'Tap the customer’s band for this sale. Its wallet must be active.');
        if (charge.status === 'reversed') {
          if (String(charge.reversal?.by) !== merchantOperatorId || charge.reversal?.reason !== reason || charge.reversal?.restocked !== restock) throw new HttpError(409, 'This sale has already been reversed');
          result = { charge, wallet }; return;
        }
        if (charge.waiterId) throw new HttpError(409, 'Table payments must be reversed as a whole');
        const cash = charge.cashFundedAmount;
        if (!Number.isSafeInteger(cash) || cash! < 0 || cash! > charge.amount) throw new HttpError(409, 'This sale predates reversal support. Its funding split cannot be safely restored.');
        if (!Number.isSafeInteger(charge.amount) || charge.amount !== charge.netAmount + charge.fee + charge.purchaseChargeAmount) throw new HttpError(409, 'Sale amounts do not reconcile');
        if (!Number.isSafeInteger(wallet.balance + charge.amount) || !Number.isSafeInteger(wallet.cashFundedBalance + cash!)) throw new HttpError(409, 'Refund would exceed the wallet limit');
        if (restock && !charge.items?.length) throw new HttpError(400, 'An amount-only sale has no items to return');
        // Writing this record and wallet in the transaction serializes competing
        // reversals and any simultaneous customer debit/cash-out. Retries see
        // the reversed status and cannot credit or restock a second time.
        charge.status = 'reversed';
        const credited = await Wallet.findOneAndUpdate({ _id: wallet._id, eventId, bandUid, status: 'active' }, { $inc: { balance: charge.amount, cashFundedBalance: cash } }, { new: true, session });
        if (!credited) throw new HttpError(409, 'Band wallet changed. Tap again.');
        if (restock) for (const item of charge.items!) {
          const productId = String(item.productId);
          await StockService.applyMovement({ eventId, merchantId, productId, delta: item.qty, reason: StockMovementReason.SALE_REVERSAL, refType: 'merchant_reversal', refId: chargeId, byType: 'Merchant', by: merchantOperatorId, note: reason, session });
          await StockAlertService.rearm(merchantId, productId, session);
        }
        const ledgerTxnId = await LedgerService.post({ eventId, refType: 'merchant_reversal', refId: chargeId, session, postings: [
          { account: { type: LedgerAccountType.WALLET, ref: String(wallet._id) }, delta: -charge.amount },
          { account: { type: LedgerAccountType.MERCHANT, ref: merchantId }, delta: charge.netAmount },
          ...(charge.fee > 0 ? [{ account: { type: LedgerAccountType.FEES }, delta: charge.fee }] : []),
          ...(charge.purchaseChargeAmount > 0 ? [{ account: { type: LedgerAccountType.ORGANIZER }, delta: charge.purchaseChargeAmount }] : []),
        ] });
        charge.reversal = { by: live._id as mongoose.Types.ObjectId, staffName: live.fullName, reason, restocked: restock, at: new Date(), ledgerTxnId };
        await charge.save({ session });
        result = { charge, wallet: credited };
      });
      return result;
    } finally { await session.endSession(); }
  }
}
