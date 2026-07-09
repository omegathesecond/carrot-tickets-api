import { Schema, model, Document, Types } from 'mongoose';

/**
 * A chat message in a community channel. Soft-deleted messages keep their
 * row (history integrity, moderation audit) but the API masks body+sender.
 * DM-thread messages arrive in Plan 3 and will reuse this model with a
 * dmThreadId — for now channelId is required.
 */
export interface IMessage extends Document {
  channelId: Types.ObjectId;
  communityId: Types.ObjectId;
  senderId: Types.ObjectId;
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
    channelId: { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message' },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'Buyer' }],
    editedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

// Cursor pagination: newest-first within a channel.
messageSchema.index({ channelId: 1, _id: -1 });

// Unread badges: countDocuments({ channelId, createdAt: { $gt: since } }).
messageSchema.index({ channelId: 1, createdAt: -1 });

export const Message = model<IMessage>('Message', messageSchema);
