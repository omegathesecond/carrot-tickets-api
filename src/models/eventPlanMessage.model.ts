import { Schema, model, Document, Types } from 'mongoose';
import { mediaSchema } from '@models/shared/media.schema';
import type { UpdateMedia } from '@interfaces/update.interface';

/**
 * A post inside a Trip Plan's "Posts" tab (renamed from "Conversation" —
 * spec §5/§6). Every existing plain-text row keeps working unchanged: `kind`
 * defaults to 'text' and `media` is only ever populated on an 'image'/'video'
 * post, mirroring Update's kind/media split (@models/update.model) so the
 * same upload -> presign -> finalize -> transcode pipeline can be reused
 * as-is (see eventPlanMessage.service#createPost/finalizePost).
 */
export interface IEventPlanMessage extends Document {
  planId: Types.ObjectId;
  senderId: Types.ObjectId;
  kind: 'text' | 'image' | 'video';
  body: string;
  media: UpdateMedia[];
  replyTo?: Types.ObjectId;
  /** Client-generated dedupe key (spec §6 — "prevent duplicate posts when a
   *  submission is retried"). Only set on posts created through the retry-
   *  safe createPost path; plain text sends (send()) don't need it since a
   *  failed text POST is trivially safe to just resend. */
  clientToken?: string;
  /** Set the first time a post's caption is edited post-publish (spec §6). */
  editedAt?: Date;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const eventPlanMessageSchema = new Schema<IEventPlanMessage>(
  {
    planId: { type: Schema.Types.ObjectId, ref: 'EventPlan', required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    kind: { type: String, enum: ['text', 'image', 'video'], required: true, default: 'text' },
    body: { type: String, trim: true, default: '', maxlength: 2000 },
    media: {
      type: [mediaSchema],
      default: [],
      validate: {
        validator: function (this: IEventPlanMessage, v: unknown[]) {
          if (this.kind === 'text') return !v || v.length === 0;
          return Array.isArray(v) && v.length >= 1 && v.length <= 5;
        },
        message: 'media must be empty for a text post, or have 1-5 items for an image/video post',
      },
    },
    replyTo: { type: Schema.Types.ObjectId, ref: 'EventPlanMessage' },
    clientToken: { type: String, maxlength: 100 },
    editedAt: { type: Date },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

eventPlanMessageSchema.pre('validate', function (next) {
  if (this.kind === 'text' && !this.body?.trim() && (!this.media || this.media.length === 0)) {
    next(new Error('Message cannot be empty'));
    return;
  }
  next();
});

// Cursor pagination: newest-first within a plan.
eventPlanMessageSchema.index({ planId: 1, _id: -1 });
// Retry-safe create: the same (plan, sender, clientToken) never creates two
// posts (spec §6 — "prevent duplicate posts when a submission is retried").
eventPlanMessageSchema.index(
  { planId: 1, senderId: 1, clientToken: 1 },
  { unique: true, partialFilterExpression: { clientToken: { $exists: true } } }
);

export const EventPlanMessage = model<IEventPlanMessage>('EventPlanMessage', eventPlanMessageSchema);
