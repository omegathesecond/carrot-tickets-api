// api/src/models/merchantCharge.model.ts
import { Schema, model, Document, Types } from 'mongoose';

/**
 * One completed tap-to-pay charge (cashless spec) — the durable record of a
 * MerchantService.charge() success, alongside the wallet debit and the
 * balanced LedgerEntry postings it wrote in the same transaction. A charge
 * that DECLINED (insufficient balance / inactive wallet) never reaches this
 * collection — see MerchantService.charge / WalletDeclinedError.
 */
export interface IMerchantCharge extends Document {
  merchantId: Types.ObjectId;
  eventId: Types.ObjectId;
  walletId: Types.ObjectId;
  bandUid: string;
  /** Amount debited from the wallet, integer minor units (cents). */
  amount: number;
  /** Platform commission taken from `amount`, integer minor units (cents). */
  fee: number;
  /** amount - fee: what the merchant is owed, integer minor units (cents). */
  netAmount: number;
  clientTxnId: string;
  status: 'completed';
  items?: Array<{ productId: Types.ObjectId; name: string; unitPrice: number; qty: number; lineTotal: number }>;
  staffName?: string;
  createdAt: Date;
}

const merchantChargeSchema = new Schema<IMerchantCharge>({
  merchantId: { type: Schema.Types.ObjectId, required: true, index: true },
  eventId: { type: Schema.Types.ObjectId, required: true, index: true },
  walletId: { type: Schema.Types.ObjectId, required: true, index: true },
  bandUid: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'amount must be integer cents' } },
  fee: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'fee must be integer cents' } },
  netAmount: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'netAmount must be integer cents' } },
  clientTxnId: { type: String, required: true },
  status: { type: String, enum: ['completed'], required: true, default: 'completed' },
  items: {
    type: [new Schema({
      productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
      name: { type: String, required: true },
      unitPrice: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'unitPrice must be integer cents' } },
      qty: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
      lineTotal: { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: 'lineTotal must be integer cents' } },
    }, { _id: false })],
    required: false,
    get: (val: any) => val && val.length > 0 ? val : undefined,
  },
  staffName: { type: String, trim: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Idempotency scoped to the OWNING merchant, NOT global — mirrors
// WalletTopup's {walletId, clientTxnId} scoping (see walletTopup.model.ts).
// The same clientTxnId reused by a DIFFERENT merchant is a different,
// legitimate charge, not a duplicate of this one.
merchantChargeSchema.index({ merchantId: 1, clientTxnId: 1 }, { unique: true });

export const MerchantCharge = model<IMerchantCharge>('MerchantCharge', merchantChargeSchema);
