import mongoose, { Schema } from 'mongoose';
import { ITable } from '@interfaces/table.interface';

const integerCents = {
  validator: Number.isSafeInteger,
  message: '{PATH} must be integer minor units (ZAR cents)',
};

const tableLineSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true, trim: true },
  unitPrice: { type: Number, required: true, min: 0, validate: integerCents },
  qty: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
  addedBy: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
});

const tableSchema = new Schema<ITable>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  label: { type: String, required: true, trim: true },
  status: { type: String, enum: ['open', 'settled', 'voided'], default: 'open', required: true, index: true },
  openedBy: { type: String, required: true },
  items: { type: [tableLineSchema], default: [] },
  subtotal: { type: Number, default: 0, min: 0, validate: integerCents },
  settledAt: { type: Date },
  settledBy: { type: String },
  walletId: { type: Schema.Types.ObjectId, ref: 'Wallet' },
  // Looked up, not constrained: uniqueness for a settling request is already
  // enforced per-stall by MerchantCharge's {merchantId, clientTxnId} index. This
  // field only needs to be found again so a retried settle can be told apart
  // from a genuine second attempt — see ITable.settleTxnId for the reasoning.
  settleTxnId: { type: String, trim: true, index: true },
  voidedAt: { type: Date },
  voidReason: { type: String, trim: true },
}, { timestamps: true });

// One OPEN table per label per event. PARTIAL so a settled "7" frees the name
// for the next group — the same reasoning as the wallet bandUid index.
tableSchema.index(
  { eventId: 1, label: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);

export const Table = mongoose.model<ITable>('Table', tableSchema);
