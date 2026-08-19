// api/src/models/cashier.model.ts
import mongoose, { Schema } from 'mongoose';
import { ICashier } from '@interfaces/cashier.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

/**
 * In-venue money-desk operator for an organizer (cashless spec — cashier
 * slice). Same PIN-login shape as GateOperator, reusing the shared
 * applyOperatorCredentials mechanism (pin hash, lockout, comparePin) — this
 * actor is NOT a reseller and never carries reseller naming.
 *
 * Unlike GateOperator/ResellerOperator, a cashier does NOT use
 * applyOperatorEventScope — a cashier is hired for exactly one event, not a
 * set of events, so the shared multi-event `eventIds` mechanism doesn't fit
 * here. See the `eventId` field below instead.
 */
const cashierSchema = new Schema<ICashier>({
  fullName: { type: String, required: true, trim: true },
  phoneNumber: { type: String, trim: true, unique: true, sparse: true },
  loginCode: { type: String, required: true, unique: true, index: true, trim: true },
  scope: { type: String, required: true, enum: ['platform', 'organizer'], index: true },
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    index: true,
    immutable: true,
    // Organizer cashiers are hired for ONE event and end with it. Platform
    // cashiers are Carrot's own staff and are legitimately global.
    required: function (this: { scope?: string }) { return this.scope === 'organizer'; },
  },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(cashierSchema);

cashierSchema.index({ vendorId: 1, isActive: 1 });
cashierSchema.index({ eventId: 1, isActive: 1 });

export const Cashier = mongoose.model<ICashier>('Cashier', cashierSchema);
