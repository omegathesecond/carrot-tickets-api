import { Schema, model, Document, Types } from 'mongoose';

export type MeetupStatus = 'pending' | 'accepted' | 'declined';

/**
 * A buyer→buyer meetup request created from the Nearby people list. One row per
 * direction (unique requester+target). Re-requesting after a decline flips the
 * SAME row back to `pending` (clearing `respondedAt`), so a declined request
 * never leaves an orphaned second row. This is deliberately NOT a follow edge —
 * follows are instant/statusless; a meetup carries an accept/deny lifecycle.
 */
export interface IMeetupRequest extends Document {
  requesterId: Types.ObjectId;
  targetId: Types.ObjectId;
  status: MeetupStatus;
  respondedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const meetupRequestSchema = new Schema<IMeetupRequest>(
  {
    requesterId: { type: Schema.Types.ObjectId, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, enum: ['pending', 'accepted', 'declined'], required: true, default: 'pending' },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);

// One request per direction; re-request reuses this row (see service).
meetupRequestSchema.index({ requesterId: 1, targetId: 1 }, { unique: true });
// Incoming tabs: a target's requests filtered by status, newest first.
meetupRequestSchema.index({ targetId: 1, status: 1, _id: -1 });
// Outgoing-status hydration for the Nearby cards.
meetupRequestSchema.index({ requesterId: 1 });

export const MeetupRequest = model<IMeetupRequest>('MeetupRequest', meetupRequestSchema);
