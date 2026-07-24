import mongoose, { Schema, Document, Types } from 'mongoose';
import { mediaSchema } from '@models/shared/media.schema';
import type { StoryAuthorType, StoryKind, StoryMedia } from '@interfaces/story.interface';

/**
 * Ephemeral 24h media post (Instagram/WhatsApp-style "Story"). Author is a
 * buyer or an organizer brand (Vendor) — same author vocabulary as Update
 * (@models/update.model). `expiresAt` is set at create time
 * (createdAt + 24h, see story.service#createStory) and the TTL index below
 * makes Mongo auto-delete the document once it passes — no cron/sweep needed
 * for cleanup. Reads still filter `expiresAt: {$gt: now}` explicitly (see
 * story.service#listForViewer) since the TTL monitor only runs ~once/60s and
 * must not be relied on for read-time correctness.
 */
export interface IStory extends Document {
  authorType: StoryAuthorType;
  authorId: Types.ObjectId;
  kind: StoryKind;
  media: StoryMedia;
  createdAt: Date;
  expiresAt: Date;
}

const storySchema = new Schema<IStory>({
  authorType: { type: String, enum: ['buyer', 'vendor'], required: true },
  authorId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['image', 'video'], required: true },
  media: { type: mediaSchema, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Auto-expiry: Mongo's TTL monitor deletes a document once expiresAt is in
// the past (expireAfterSeconds:0 means "at expiresAt itself", not an offset).
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// An author's own stories, newest first (profile "My Story" tray).
storySchema.index({ authorType: 1, authorId: 1, createdAt: -1 });

export const Story = mongoose.model<IStory>('Story', storySchema);
