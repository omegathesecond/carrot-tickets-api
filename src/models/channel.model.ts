import { Schema, model, Document, Types } from 'mongoose';

export type ChannelPostPolicy = 'all' | 'organizer';

/**
 * A text channel inside an event community. `gated` channels are readable
 * and writable only by verified ticket-holders; `postPolicy: 'organizer'`
 * makes a channel read-only for buyers (e.g. #announcements).
 */
export interface IChannel extends Document {
  communityId: Types.ObjectId;
  name: string;
  slug: string;
  gated: boolean;
  postPolicy: ChannelPostPolicy;
  archived: boolean;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const channelSchema = new Schema<IChannel>(
  {
    communityId: { type: Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    gated: { type: Boolean, default: false },
    postPolicy: { type: String, enum: ['all', 'organizer'], default: 'all' },
    archived: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

channelSchema.index({ communityId: 1, slug: 1 }, { unique: true });

export const Channel = model<IChannel>('Channel', channelSchema);
