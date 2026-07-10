import { Schema, model, Document, Types } from 'mongoose';

/**
 * A chat message in a community channel. Soft-deleted messages keep their
 * row (history integrity, moderation audit) but the API masks body+sender.
 * A message belongs to exactly ONE container: a channel (with its community) or a DM thread.
 */
export interface IMessage extends Document {
  channelId?: Types.ObjectId;
  communityId?: Types.ObjectId;
  dmThreadId?: Types.ObjectId;
  senderId?: Types.ObjectId;
  senderVendorId?: Types.ObjectId;
  body: string;
  replyTo?: Types.ObjectId;
  mentions: Types.ObjectId[];
  editedAt?: Date;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    channelId: { type: Schema.Types.ObjectId, ref: 'Channel' },
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', index: true },
    dmThreadId: { type: Schema.Types.ObjectId, ref: 'DmThread' },
    senderId: { type: Schema.Types.ObjectId, ref: 'Buyer', index: true },
    senderVendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', index: true },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message' },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'Buyer' }],
    editedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

// Exactly one container per message; channel messages carry their community
// for moderation/authz lookups.
messageSchema.pre('validate', function (next) {
  const hasChannel = Boolean(this.channelId);
  const hasThread = Boolean(this.dmThreadId);
  if (hasChannel === hasThread) {
    return next(new Error('Message must have exactly one of channelId or dmThreadId'));
  }
  if (hasChannel && !this.communityId) {
    return next(new Error('Channel messages require communityId'));
  }

  const hasBuyerSender = Boolean(this.senderId);
  const hasVendorSender = Boolean(this.senderVendorId);
  if (hasBuyerSender === hasVendorSender) {
    return next(new Error('Message must have exactly one sender (buyer or organizer)'));
  }
  next();
});

// Cursor pagination: newest-first within a channel.
messageSchema.index({ channelId: 1, _id: -1 });

// Unread badges: countDocuments({ channelId, createdAt: { $gt: since } }).
messageSchema.index({ channelId: 1, createdAt: -1 });

// DM cursor pagination + unread counts.
messageSchema.index({ dmThreadId: 1, _id: -1 });
messageSchema.index({ dmThreadId: 1, createdAt: -1 });

export const Message = model<IMessage>('Message', messageSchema);
