import { Schema } from 'mongoose';

/**
 * Shared media sub-schema: raw upload -> processing -> ready/failed, with an
 * image or video rendition attached once ready. Originally defined inline in
 * update.model.ts; extracted so Story (ephemeral 24h media) can reuse the
 * exact same shape/behavior instead of re-declaring it (DRY — see
 * story.model.ts). Safe to embed this same Schema instance as a single
 * nested field on multiple parent schemas.
 */
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

export const mediaSchema = new Schema({
  rawKey: { type: String, required: true },
  status: { type: String, enum: ['processing', 'ready', 'failed'], required: true, default: 'processing', index: true },
  video: { type: videoSchema },
  image: { type: imageSchema },
  error: { type: String, maxlength: 500 },
  processingStartedAt: { type: Date },
}, { _id: false });
