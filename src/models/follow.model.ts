import { Schema, model, Document, Types } from 'mongoose';

export type FollowTargetType = 'buyer' | 'organizer';

/**
 * A directed follow edge. Buyers follow buyers (mutual = friends) and
 * organizers (Vendors — powers announcement fan-out and tailored push in
 * later plans).
 */
export interface IFollow extends Document {
  followerId: Types.ObjectId;
  targetType: FollowTargetType;
  targetId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const followSchema = new Schema<IFollow>(
  {
    followerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    targetType: { type: String, enum: ['buyer', 'organizer'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

followSchema.index({ followerId: 1, targetType: 1, targetId: 1 }, { unique: true });
// Follower counts / lists for a target.
followSchema.index({ targetType: 1, targetId: 1 });

export const Follow = model<IFollow>('Follow', followSchema);
