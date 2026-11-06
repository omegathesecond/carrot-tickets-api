import { Schema, model } from 'mongoose';

export const PREPARATION_CATEGORIES = [
  'hair', 'nails', 'makeup', 'barber', 'beauty_spa', 'accommodation', 'transport',
  'car_hire', 'outfit_clothing', 'shoes', 'photography', 'tour_guide', 'babysitting', 'event_companion', 'other',
] as const;

const offerSchema = new Schema({
  actorId: { type: Schema.Types.ObjectId, required: true },
  actorType: { type: String, enum: ['vendor', 'buyer'], required: true },
  name: { type: String, required: true },
  price: { type: Number, min: 0, required: true },
  description: { type: String, required: true, maxlength: 2000 },
  availableTime: { type: Date, required: true },
  location: { type: String, required: true, maxlength: 300 },
  photos: [{ type: String, maxlength: 1000 }],
  message: { type: String, maxlength: 1000 },
  deposit: { type: Number, min: 0, required: true },
  cancellationTerms: { type: String, required: true, maxlength: 2000 },
}, { timestamps: true });

const schema = new Schema({
  buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true },
  category: { type: String, enum: PREPARATION_CATEGORIES, required: true },
  budget: { type: Number, min: 0, required: true },
  preferredDate: { type: Date, required: true },
  location: { type: String, required: true, maxlength: 300 },
  note: { type: String, maxlength: 1000 },
  mode: { type: String, enum: ['open', 'invite'], required: true },
  providerIds: [{ type: Schema.Types.ObjectId, ref: 'Vendor' }],
  status: { type: String, enum: ['looking', 'booked', 'removed'], default: 'looking', required: true },
  acceptedOfferId: Schema.Types.ObjectId,
  offers: { type: [offerSchema], default: [] },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ buyerId: 1, eventId: 1, status: 1 });
schema.index({ category: 1, status: 1, preferredDate: 1 });
schema.index({ providerIds: 1, status: 1 });
export const Preparation = model('Preparation', schema);
