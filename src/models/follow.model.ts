import { Schema, model, Document, Types } from 'mongoose';

export type FollowTargetType = 'buyer' | 'organizer';
export type FollowerType = 'buyer' | 'vendor';

/**
 * A directed follow edge. The follower is a buyer or an organizer brand
 * (Vendor); the target is a buyer or an organizer. followerId holds the
 * follower's id regardless of followerType.
 */
export interface IFollow extends Document {
  followerType: FollowerType;
  followerId: Types.ObjectId;
  targetType: FollowTargetType;
  targetId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const followSchema = new Schema<IFollow>(
  {
    followerType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    followerId: { type: Schema.Types.ObjectId, required: true },
    targetType: { type: String, enum: ['buyer', 'organizer'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

// One edge per (follower, target). followerType disambiguates a buyer and a
// vendor that share an ObjectId value.
followSchema.index({ followerType: 1, followerId: 1, targetType: 1, targetId: 1 }, { unique: true });
// Follower counts / lists for a target.
followSchema.index({ targetType: 1, targetId: 1 });

export const Follow = model<IFollow>('Follow', followSchema);
