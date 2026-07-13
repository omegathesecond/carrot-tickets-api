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

// DEPLOY (one-time, SP1b): existing rows predate `followerType` (stored as
// null). BEFORE relying on the new index / dropping the legacy one, BACKFILL:
//   db.follows.updateMany({ followerType: { $exists: false } }, { $set: { followerType: 'buyer' } })
// Only AFTER the backfill may the legacy index be dropped (optional, hygiene):
//   db.follows.dropIndex('followerId_1_targetType_1_targetId_1')
// Dropping WITHOUT backfilling lets a pre-migration buyer create a duplicate
// follow edge (null-keyed old row won't collide with a 'buyer'-keyed new one).
followSchema.index({ followerType: 1, followerId: 1, targetType: 1, targetId: 1 }, { unique: true });
// Follower counts / lists for a target.
followSchema.index({ targetType: 1, targetId: 1 });

export const Follow = model<IFollow>('Follow', followSchema);
