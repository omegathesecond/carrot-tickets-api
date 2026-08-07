import { Schema, model, Document, Types } from 'mongoose';

export type MembershipRole = 'member' | 'moderator' | 'organizer';

/**
 * A member of one event community — a ticket-buyer OR an organizer brand
 * (Vendor). Exactly one of `buyerId`/`vendorId` is set (enforced below),
 * mirroring the same polymorphic-sender shape `Message` uses. Everything else
 * is member-agnostic: `ticketVerifiedAt` caches the ticket-holder check that
 * unlocks gated channels (buyers only — a brand holds no ticket), moderation
 * state (mutedUntil/bannedAt) lives here, and `readState` maps
 * channelId -> last read time for unread badges.
 */
export interface IMembership extends Document {
  buyerId?: Types.ObjectId;
  vendorId?: Types.ObjectId;
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
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer' },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
    role: { type: String, enum: ['member', 'moderator', 'organizer'], default: 'member' },
    ticketVerifiedAt: { type: Date },
    mutedUntil: { type: Date },
    bannedAt: { type: Date },
    readState: { type: Map, of: Date, default: {} },
  },
  { timestamps: true }
);

// Exactly one member identity per row — a buyer XOR an organizer brand
// (same invariant Message enforces for its sender).
membershipSchema.pre('validate', function (next) {
  const hasBuyer = Boolean(this.buyerId);
  const hasVendor = Boolean(this.vendorId);
  if (hasBuyer === hasVendor) {
    return next(new Error('Membership must have exactly one member (buyer or organizer)'));
  }
  next();
});

// One membership per (member, community). PARTIAL — not plain-unique — so the
// two actor kinds never collide: a plain compound unique index would treat
// every vendor row's absent buyerId as `null` and reject a second vendor
// joining the same community. Each index only covers rows where its own actor
// field exists.
membershipSchema.index(
  { buyerId: 1, communityId: 1 },
  { unique: true, partialFilterExpression: { buyerId: { $exists: true } } }
);
membershipSchema.index(
  { vendorId: 1, communityId: 1 },
  { unique: true, partialFilterExpression: { vendorId: { $exists: true } } }
);
// Activity feed: global newest-first scan of community joins ("is going").
membershipSchema.index({ createdAt: -1 });

export const Membership = model<IMembership>('Membership', membershipSchema);
