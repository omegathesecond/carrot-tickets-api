import mongoose, { Schema } from 'mongoose';
import { ITicketsUserAccess } from '@interfaces/userAccess.interface';
import { TicketsRole, TicketsPermission } from '@interfaces/ticketsPermission.interface';

const ticketsUserAccessSchema = new Schema<ITicketsUserAccess>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'VendorSubUser',
    required: [true, 'User ID is required'],
    index: true
  },
  vendorId: {
    type: Schema.Types.ObjectId,
    ref: 'Vendor',
    required: [true, 'Vendor ID is required'],
    index: true
  },
  role: {
    type: String,
    enum: Object.values(TicketsRole),
    required: [true, 'Role is required']
  },
  permissions: {
    type: [String],
    enum: Object.values(TicketsPermission),
    default: []
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, {
  timestamps: true,
  toJSON: {
    transform: function(doc, ret) {
      const { __v, ...rest } = ret;
      return rest;
    }
  }
});

// Compound unique index - one user can only have one access record per vendor
ticketsUserAccessSchema.index({ userId: 1, vendorId: 1 }, { unique: true });

// Index for efficient queries
ticketsUserAccessSchema.index({ vendorId: 1, isActive: 1 });

export const TicketsUserAccess = mongoose.model<ITicketsUserAccess>('TicketsUserAccess', ticketsUserAccessSchema);
