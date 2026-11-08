import { Schema, model } from 'mongoose';

const schema = new Schema({
  targetType: { type: String, enum: ['buyer', 'vendor'], required: true },
  targetId: { type: Schema.Types.ObjectId, required: true },
  visitorKey: { type: String, required: true },
}, { timestamps: true });
// Lifetime uniqueness, including concurrent page loads. Vendor covers every
// operator vertical (organizer, venue, service provider, transport, etc.).
schema.index({ targetType: 1, targetId: 1, visitorKey: 1 }, { unique: true });
export const ProfileVisit = model('ProfileVisit', schema);

// A browser keeps its resolved account identity after sign-out, avoiding a
// second guest view from the same browser. No IP addresses are stored.
const visitorSchema = new Schema({
  guestKey: { type: String, required: true, unique: true },
  actorKey: { type: String, required: true },
});
export const ProfileVisitor = model('ProfileVisitor', visitorSchema);
