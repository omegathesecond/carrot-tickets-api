import mongoose, { Schema } from 'mongoose';
import { IVenue } from '@interfaces/venue.interface';

const venueSchema = new Schema<IVenue>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  currency: { type: String, enum: ['SZL', 'ZAR'], required: true },
  status: { type: String, enum: ['active', 'suspended'], default: 'active', required: true, index: true },
  activatedAt: { type: Date, required: true, default: Date.now },
  activatedBy: { type: String, required: true, trim: true },
}, { timestamps: true });

// One location per venue account (v1). UNIQUE rather than a find-then-insert
// check: two admins (or one double click) switching on at the same moment
// race past any pre-check, and only the index makes the loser an E11000 that
// VenueService turns into a 409 instead of a second Venue.
venueSchema.index({ vendorId: 1 }, { unique: true });

export const Venue = mongoose.model<IVenue>('Venue', venueSchema);
