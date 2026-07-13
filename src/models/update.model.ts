import mongoose, { Schema, Document, Types } from 'mongoose';
import type { UpdateAuthorType, UpdateKind, UpdateMedia } from '@interfaces/update.interface';

export interface IUpdate extends Document {
  authorType: UpdateAuthorType;
  authorId: Types.ObjectId;
  kind: UpdateKind;
  caption: string;
  eventId?: Types.ObjectId;
  media: UpdateMedia;
  likeCount: number;
  saveCount: number;
  shareCount: number;
  viewCount: number;
  commentCount: number;   // stays 0 in v1
  status: 'active' | 'removed';
  createdAt: Date;
  updatedAt: Date;
}

const videoSchema = new Schema({
  url: { type: String, required: true },
  url480: { type: String },
  poster: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  durationSec: { type: Number, required: true },
}, { _id: false });

const imageSchema = new Schema({
  url: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
}, { _id: false });

const mediaSchema = new Schema({
  rawKey: { type: String, required: true },
  status: { type: String, enum: ['processing', 'ready', 'failed'], required: true, default: 'processing', index: true },
  video: { type: videoSchema },
  image: { type: imageSchema },
  error: { type: String, maxlength: 500 },
  processingStartedAt: { type: Date },
}, { _id: false });

const updateSchema = new Schema<IUpdate>({
  authorType: { type: String, enum: ['vendor', 'buyer'], required: true },
  authorId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['video', 'image'], required: true },
  caption: { type: String, default: '', maxlength: 500 },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', index: true },
  media: { type: mediaSchema, required: true },
  likeCount: { type: Number, default: 0 },
  saveCount: { type: Number, default: 0 },
  shareCount: { type: Number, default: 0 },
  viewCount: { type: Number, default: 0 },
  commentCount: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'removed'], default: 'active', index: true },
}, { timestamps: true });

updateSchema.index({ createdAt: -1 });
updateSchema.index({ authorType: 1, authorId: 1, createdAt: -1 });
updateSchema.index({ 'media.status': 1, status: 1, createdAt: -1 });

export const Update = mongoose.model<IUpdate>('Update', updateSchema);
