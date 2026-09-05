import mongoose, { Schema } from 'mongoose';
import { IWaiter } from '@interfaces/waiter.interface';
import { applyOperatorCredentials } from '@models/operatorCredentials.schema';

/**
 * Floor waiter for an organizer — opens tables, collects items from several
 * stalls onto them, settles at the end. Same PIN-login shape as Cashier via
 * applyOperatorCredentials.
 *
 * Like a cashier and unlike a gate operator, a waiter works exactly ONE event,
 * so this carries `eventId` rather than the shared multi-event `eventIds`.
 */
const waiterSchema = new Schema<IWaiter>({
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
    required: function (this: { scope?: string }) { return this.scope === 'organizer'; },
  },
  isActive: { type: Boolean, default: true, index: true },
}, {
  timestamps: true,
  toJSON: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
  toObject: { transform: (_doc, ret) => { const { pin, __v, ...rest } = ret; return rest; } },
});

applyOperatorCredentials(waiterSchema);

waiterSchema.index({ vendorId: 1, isActive: 1 });
waiterSchema.index({ eventId: 1, isActive: 1 });

export const Waiter = mongoose.model<IWaiter>('Waiter', waiterSchema);
