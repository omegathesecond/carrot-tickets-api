import { Schema, model, Document, Types } from 'mongoose';

/**
 * An attendee CASH-OUT: money leaving a wallet as physical cash handed back at
 * the venue by a cashier (cashless spec — cashier slice). The mirror image of
 * WalletTopup: same shape, opposite money direction. The wallet debit + ledger
 * legs happen in WalletService.withdrawCash; this row is the durable, idempotent
 * record of it.
 */
export interface IWalletWithdrawal extends Document {
  walletId: Types.ObjectId;
  eventId: Types.ObjectId;
  amount: number;
  method: 'cash';
  status: 'completed';
  /** Actor id that recorded this cash-out (a cashier id in v1). */
  recordedBy: string;
  /** Actor population, so reports/attribution can distinguish cashier vs other writers. */
  recordedByType: 'Cashier' | 'ResellerOperator' | 'Merchant' | 'Platform';
  clientTxnId: string;
  createdAt: Date;
}

const walletWithdrawalSchema = new Schema<IWalletWithdrawal>({
  walletId: { type: Schema.Types.ObjectId, required: true, index: true },
  eventId: { type: Schema.Types.ObjectId, required: true, index: true },
  amount: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'amount must be integer cents' } },
  method: { type: String, enum: ['cash'], required: true, default: 'cash' },
  status: { type: String, enum: ['completed'], required: true, default: 'completed' },
  recordedBy: { type: String, required: true, index: true },
  recordedByType: { type: String, enum: ['Cashier', 'ResellerOperator', 'Merchant', 'Platform'], required: true, default: 'Cashier' },
  clientTxnId: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Idempotency scoped to the OWNING wallet (same reasoning as WalletTopup): a
// genuine retry for the same wallet dedups; the same clientTxnId on a different
// wallet is a different, legitimate cash-out.
walletWithdrawalSchema.index({ walletId: 1, clientTxnId: 1 }, { unique: true });

export const WalletWithdrawal = model<IWalletWithdrawal>('WalletWithdrawal', walletWithdrawalSchema);
