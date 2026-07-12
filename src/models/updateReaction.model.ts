import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUpdateReaction extends Document {
  updateId: Types.ObjectId;
  buyerId: Types.ObjectId;
  type: 'like' | 'save';
  createdAt: Date;
}

const schema = new Schema<IUpdateReaction>({
  updateId: { type: Schema.Types.ObjectId, ref: 'Update', required: true, index: true },
  buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
  type: { type: String, enum: ['like', 'save'], required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ updateId: 1, buyerId: 1, type: 1 }, { unique: true });
schema.index({ buyerId: 1, type: 1, createdAt: -1 }); // "my saved updates"

export const UpdateReaction = mongoose.model<IUpdateReaction>('UpdateReaction', schema);
