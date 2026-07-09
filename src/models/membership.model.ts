import { Schema, model, Document, Types } from 'mongoose';

export type MembershipRole = 'member' | 'moderator' | 'organizer';

/**
 * A buyer's membership of one event community. `ticketVerifiedAt` caches the
 * ticket-holder check that unlocks gated channels; moderation state
 * (mutedUntil/bannedAt) lives here too. `readState` maps channelId -> last
 * read time (consumed by the realtime plan for unread badges).
 */
export interface IMembership extends Document {
  buyerId: Types.ObjectId;
  communityId: Types.ObjectId;
  role: MembershipRole;
  ticketVerifiedAt?: Date;
  mutedUntil?: Date;
  bannedAt?: Date;
  readState: Map<string, Date>;
  createdAt: Date;
  updatedAt: Date;
}

const membershipSchema = new Schema<IMembership>(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
    role: { type: String, enum: ['member', 'moderator', 'organizer'], default: 'member' },
    ticketVerifiedAt: { type: Date },
    mutedUntil: { type: Date },
    bannedAt: { type: Date },
    readState: { type: Map, of: Date, default: {} },
  },
  { timestamps: true }
);

membershipSchema.index({ buyerId: 1, communityId: 1 }, { unique: true });

export const Membership = model<IMembership>('Membership', membershipSchema);
