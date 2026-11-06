import mongoose from 'mongoose';
import { Merchant } from '@models/merchant.model';
import { MerchantCharge, IMerchantCharge } from '@models/merchantCharge.model';
import { Product } from '@models/product.model';
import { VenuePayment } from '@models/venuePayment.model';
import { IVenuePayment } from '@interfaces/venuePayment.interface';
import { StockMovementReason } from '@interfaces/stock.interface';
import { StockService } from '@services/stock.service';
import { ChargeIdempotencyMismatchError, MAX_CHARGE_CENTS, basketKey } from '@services/merchant.service';
import { TenderInput, normalizeTenders, sumTenders } from '@utils/tenders.util';

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** A counter sale that cannot be made as asked. 400 — nothing is written. */
export class CounterSaleRefusedError extends Error {
  constructor(message: string, public reason: string, public detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CounterSaleRefusedError';
  }
}

export interface CounterSale { charge: IMerchantCharge; payment: IVenuePayment }

/** Selling over the counter at a venue till (venue trading Phase 3): tagless, paid at once. */
export class VenueSaleService {
  /**
   * ONE transaction: every stock movement (hard-blocked at zero), the stall's
   * MerchantCharge, and the VenuePayment. The tenders must add up to exactly
   * the basket. A retry with the same clientTxnId returns the first sale.
   */
  static async counterSale(params: {
    venueId: string; merchantId: string; merchantName: string; merchantOperatorId: string; operatorName: string;
    clientTxnId: string; items: Array<{ productId: string; qty: number }>; tenders: TenderInput[];
  }): Promise<CounterSale> {
    const { clientTxnId, merchantOperatorId } = params;
    const venueId = oid(params.venueId);
    const merchantId = oid(params.merchantId);

    const replay = async (): Promise<CounterSale | null> => {
      const charge = await MerchantCharge.findOne({ merchantId, clientTxnId });
      if (!charge) return null;
      if (basketKey(charge.items ?? []) !== basketKey(params.items)) throw new ChargeIdempotencyMismatchError(clientTxnId);
      // A charge and its payment are written together, so a charge with no counter payment of its own
      // is somebody else's row under this id (a table's closing charge, say) — not this sale.
      const payment = await VenuePayment.findOne({ venueId, clientTxnId });
      if (!payment || payment.source !== 'counter' || String(payment.merchantChargeId) !== String(charge._id)) {
        throw new ChargeIdempotencyMismatchError(clientTxnId);
      }
      return { charge, payment };
    };
    // An id is the venue's, not the stall's: a table payment or another stall's sale under it is a mismatch.
    // Order matters: the payment is read BEFORE the charge, so a twin committing between the two reads is seen as the sale it is, never as a mismatch.
    const settled = async (): Promise<CounterSale | null> => {
      const taken = await VenuePayment.exists({ venueId, clientTxnId });
      const sale = await replay();
      if (sale) return sale;
      if (taken) throw new ChargeIdempotencyMismatchError(clientTxnId);
      return null;
    };
    const earlier = await settled();
    if (earlier) return earlier;

    const attempt = async (): Promise<CounterSale> => {
      const merged = new Map<string, number>();
      for (const { productId, qty } of params.items) merged.set(productId, (merged.get(productId) ?? 0) + qty);
      const ids = [...merged.keys()];
      const found = await Product.find({ _id: { $in: ids.map(oid) }, venueId, active: true }).select('name price').lean<{ _id: mongoose.Types.ObjectId; name: string; price: number }[]>();
      const byId = new Map(found.map((p) => [String(p._id), p]));
      if (ids.some((id) => !byId.has(id))) throw new CounterSaleRefusedError("one or more products are not on this venue's menu", 'product_not_found');
      // In the order the till rang them up (as the event charge keeps them), not the database's.
      const items = ids.map((id) => {
        const p = byId.get(id)!;
        const qty = merged.get(id)!;
        return { productId: p._id, name: p.name, unitPrice: p.price, qty, lineTotal: p.price * qty };
      });
      const amount = items.reduce((sum, l) => sum + l.lineTotal, 0);
      if (amount < 1) throw new CounterSaleRefusedError('there is nothing to charge for', 'nothing_to_sell');
      if (amount > MAX_CHARGE_CENTS) throw new CounterSaleRefusedError('amount exceeds the maximum allowed charge', 'too_large');

      const tenders = normalizeTenders(params.tenders);
      const { applied, tips } = sumTenders(tenders);
      if (applied !== amount) throw new CounterSaleRefusedError('the payment must equal the basket total', 'payment_mismatch', { total: amount, applied });

      const now = new Date();
      const session = await mongoose.startSession();
      let out: CounterSale | undefined;
      try {
        await session.withTransaction(async () => {
          const stall = await Merchant.findOne({ _id: merchantId, venueId, status: 'active' }).session(session);
          if (!stall) throw new Error('stall not found or not active');
          for (const line of items) {
            await StockService.applySaleMovement({
              venueId, merchantId, productId: line.productId, delta: -line.qty,
              reason: StockMovementReason.SALE, refType: 'merchant_charge', refId: clientTxnId,
              byType: 'Merchant', by: merchantOperatorId, session,
            });
          }
          const [charge] = await MerchantCharge.create([{
            merchantId, venueId, amount, fee: 0, netAmount: amount, clientTxnId, status: 'completed', items,
            merchantOperatorId: oid(merchantOperatorId), staffName: params.operatorName,
          }], { session });
          const [payment] = await VenuePayment.create([{
            venueId, source: 'counter', merchantChargeId: charge!._id, merchantName: params.merchantName, merchantIds: [merchantId],
            clientTxnId, tenders, applied, tips, takenBy: merchantOperatorId, takenByType: 'MerchantOperator',
            staffName: params.operatorName, at: now,
          }], { session });
          out = { charge: charge!, payment: payment! };
        });
      } finally {
        await session.endSession();
      }
      return out!;
    };

    try {
      return await attempt();
    } catch (e: any) {
      // Whatever went wrong — a refusal, a stock decline, a duplicate key — a sale already
      // committed under this id is the answer. Only without one does the error stand.
      let again: CounterSale | null;
      try {
        again = await settled();
      } catch (check: any) {
        // A mismatch is an answer; anything else means the check itself failed, and the first error must not be lost.
        if (!(check instanceof ChargeIdempotencyMismatchError)) console.error('Counter sale failed before its replay check', e);
        throw check;
      }
      if (again) return again;
      throw e;
    }
  }
}
