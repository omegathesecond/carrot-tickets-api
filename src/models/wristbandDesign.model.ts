import mongoose, { Schema } from 'mongoose';
import { IWristbandDesign } from '@interfaces/wristbandDesign.interface';

const wristbandDesignSchema = new Schema<IWristbandDesign>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Full dimension snapshot of the sheet template at save time.
    sheetTemplate: { type: Schema.Types.Mixed, required: true },
    // Opaque editor scene (elements, background). Validated client-side.
    designJson: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId },
  },
  { timestamps: true }
);

wristbandDesignSchema.index({ eventId: 1, updatedAt: -1 });

export const WristbandDesign = mongoose.model<IWristbandDesign>(
  'WristbandDesign',
  wristbandDesignSchema
);
