import mongoose, { Schema } from 'mongoose';
import { ITable } from '@interfaces/table.interface';
import { applyTradingScope, VENUE_ONLY_INDEX } from '@models/tradingScope.schema';

const integerCents = {
  validator: Number.isSafeInteger,
  message: '{PATH} must be integer minor units (ZAR cents)',
};

const tableLineSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true, trim: true },
  unitPrice: { type: Number, required: true, min: 0, validate: integerCents },
  bundlePrice: { type: new Schema({
    quantity: { type: Number, required: true, min: 2, validate: { validator: Number.isSafeInteger } },
    price: { type: Number, required: true, min: 1, validate: integerCents },
  }, { _id: false }), default: null },
  qty: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
  addedBy: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
  // Venue lines only — NO default, so an event line never carries them.
  orderId: { type: Schema.Types.ObjectId },
  paidQty: { type: Number, min: 0, validate: { validator: Number.isInteger, message: 'paidQty must be a whole number' } },
});

// _id off: merchantId is the key (see ITableFulfilment). Every update
// addresses a row by its stall, so a second identifier would be one more thing
// that can disagree with the first.
const tableFulfilmentSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  status: { type: String, enum: ['paid', 'handed_out', 'collected'], default: 'paid', required: true },
  handedOutAt: { type: Date },
  handedOutBy: { type: String, trim: true },
  acceptedAt: { type: Date },
  acceptedBy: { type: String, trim: true },
}, { _id: false });

// A venue round, one row per stall. `_id` stays ON: the till and the waiter
// address a row by it (an event fulfilment row is keyed by its stall instead).
const tableOrderSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  lineIds: { type: [Schema.Types.ObjectId], default: [] },
  clientTxnId: { type: String, required: true, trim: true },
  status: { type: String, enum: ['sent', 'handed_out', 'collected'], default: 'sent', required: true },
  sentAt: { type: Date, required: true },
  sentBy: { type: String, required: true },
  handedOutAt: { type: Date },
  handedOutBy: { type: String, trim: true },
  acceptedAt: { type: Date },
  acceptedBy: { type: String, trim: true },
});

const tableSchema = new Schema<ITable>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', index: true },
  label: { type: String, required: true, trim: true },
  status: { type: String, enum: ['open', 'settled', 'voided'], default: 'open', required: true, index: true },
  openedBy: { type: String, required: true },
  items: { type: [tableLineSchema], default: [] },
  subtotal: { type: Number, default: 0, min: 0, validate: integerCents },
  // Optimistic-concurrency token for settlement — see ITable.revision.
  revision: { type: Number, default: 0 },
  fulfilment: { type: [tableFulfilmentSchema], default: [] },
  // Venue tables only — `default: undefined` so an event table is stored and
  // returned exactly as before.
  orders: { type: [tableOrderSchema], default: undefined },
  paidTotal: { type: Number, min: 0, validate: integerCents },
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
  voidedBy: { type: String },
}, { timestamps: true });

applyTradingScope(tableSchema);

// One OPEN table per label per event. PARTIAL so a settled "7" frees the name
// for the next group — the same reasoning as the wallet bandUid index.
// Named and label-led so they can coexist with the legacy `eventId_1_label_1`,
// which treats a venue table's missing eventId as null — see
// src/scripts/migrate-venue-selling-indexes.ts.
tableSchema.index(
  { label: 1, eventId: 1 },
  { name: 'event_open_label_unique', unique: true, partialFilterExpression: { status: 'open', eventId: { $exists: true } } },
);
tableSchema.index(
  { label: 1, venueId: 1 },
  { name: 'venue_open_label_unique', unique: true, partialFilterExpression: { status: 'open', venueId: { $exists: true } } },
);
tableSchema.index({ venueId: 1, status: 1, createdAt: -1 }, VENUE_ONLY_INDEX);
// The stall's queue: "venue tables with a round for MY stall in this state".
tableSchema.index({ venueId: 1, 'orders.merchantId': 1, 'orders.status': 1 }, VENUE_ONLY_INDEX);

// The stall's own feed: "tables at this event with a row for MY stall". Every
// merchant-side read is that question, and without this it is a collection
// scan on the busiest screen of the night.
tableSchema.index({ eventId: 1, 'fulfilment.merchantId': 1, 'fulfilment.status': 1 });

export const Table = mongoose.model<ITable>('Table', tableSchema);
