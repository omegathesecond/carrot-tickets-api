import { Schema, model } from 'mongoose';
import { IVenuePayment, TENDER_METHODS } from '@interfaces/venuePayment.interface';

const cents = { validator: Number.isSafeInteger, message: '{PATH} must be integer minor units' };

const tenderSchema = new Schema({
  method: { type: String, enum: TENDER_METHODS, required: true },
  amount: { type: Number, required: true, min: 0, validate: cents },
  tip: { type: Number, required: true, min: 0, default: 0, validate: cents },
  reference: { type: String, trim: true, maxlength: 64 },
}, { _id: false });

const forSource = (source: string) => function (this: { source?: string }) { return this.source === source; };

/**
 * Money a venue took (venue trading Phase 3). Immutable once written: a
 * mis-keyed tender is corrected by a Phase 4 shift adjustment, never by an edit.
 */
const venuePaymentSchema = new Schema<IVenuePayment>({
  venueId: { type: Schema.Types.ObjectId, ref: 'Venue', required: true },
  source: { type: String, enum: ['table', 'counter'], required: true },
  tableId: { type: Schema.Types.ObjectId, ref: 'Table', required: forSource('table') },
  tableLabel: { type: String, trim: true, required: forSource('table') },
  merchantChargeId: { type: Schema.Types.ObjectId, ref: 'MerchantCharge', required: forSource('counter') },
  merchantName: { type: String, trim: true, required: forSource('counter') },
  merchantIds: { type: [Schema.Types.ObjectId], default: [] },
  clientTxnId: { type: String, required: true, trim: true },
  tenders: { type: [tenderSchema], validate: { validator: (v: unknown[]) => v.length > 0, message: 'at least one tender is required' } },
  applied: { type: Number, required: true, min: 1, validate: cents },
  tips: { type: Number, required: true, min: 0, validate: cents },
  lines: {
    type: [new Schema({
      lineId: { type: Schema.Types.ObjectId, required: true },
      qty: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
    }, { _id: false })],
    default: undefined,
  },
  takenBy: { type: String, required: true },
  takenByType: { type: String, enum: ['Waiter', 'MerchantOperator'], required: true },
  staffName: { type: String, required: true, trim: true },
  at: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

venuePaymentSchema.pre('validate', function (next) {
  const tenders = this.tenders ?? [];
  if (this.applied !== tenders.reduce((t, x) => t + x.amount, 0)) this.invalidate('applied', 'applied must equal the sum of tender amounts');
  if (this.tips !== tenders.reduce((t, x) => t + x.tip, 0)) this.invalidate('tips', 'tips must equal the sum of tender tips');
  next();
});

// A POS retry returns the original payment.
venuePaymentSchema.index({ venueId: 1, clientTxnId: 1 }, { unique: true });
venuePaymentSchema.index({ venueId: 1, at: -1 });
venuePaymentSchema.index({ venueId: 1, tableId: 1 });

export const VenuePayment = model<IVenuePayment>('VenuePayment', venuePaymentSchema);
