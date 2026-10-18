import { Schema, model } from 'mongoose';
const ref = { type: Schema.Types.ObjectId, required: true };
const stall = new Schema(
  {
    size: String,
    power: Boolean,
    water: Boolean,
    shelter: Boolean,
    ownGazebo: Boolean,
  },
  { _id: false },
);
export const profileFields = {
  businessName: String,
  contactName: String,
  email: String,
  phone: String,
  country: String,
  regions: [String],
  categories: [String],
  currentMarkets: String,
  desiredMarkets: String,
  marketTypes: [String],
  availability: [String],
  stall,
  sellsFood: Boolean,
};
const profile = new Schema(
  { ownerId: ref, revision: { type: Number, default: 0 }, ...profileFields },
  { timestamps: true },
);
profile.index({ ownerId: 1, _id: 1 });
export const MarketProfile = model('MarketProfile', profile);
export const MarketPreference = model(
  'MarketPreference',
  new Schema({ ownerId: { ...ref, unique: true }, defaultProfileId: ref }),
);
const certificate = new Schema(
  {
    ownerId: ref,
    profileId: ref,
    type: { type: String, required: true },
    name: String,
    mime: String,
    expiresAt: Date,
    file: { type: Buffer, required: true, select: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
certificate.index({ profileId: 1, active: 1, type: 1 });
export const MarketCertificate = model('MarketCertificate', certificate);
const charge = new Schema({ label: String, amount: Number }, { _id: false });
const opportunity = new Schema(
  {
    organiserId: ref,
    organiser: String,
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
    posterUrl: String,
    name: String,
    location: String,
    country: String,
    description: String,
    marketType: String,
    categories: [String],
    availability: [String],
    dates: [String],
    scope: String,
    applicationDeadline: Date,
    paymentDeadline: Date,
    capacity: Number,
    stallSizes: [String],
    stall,
    currency: String,
    stallFee: Number,
    feeTiers: [charge],
    optionalCharges: [charge],
    cancellationTerms: String,
    requiredCertificates: [String],
    foodCertificates: [String],
    status: {
      type: String,
      enum: ['draft', 'published', 'paused', 'closed'],
      default: 'draft',
    },
    // A write fence shared by submission/edit/review transactions prevents stale
    // deadline, terms and capacity reads from committing across concurrent edits.
    revision: { type: Number, default: 0 },
  },
  { timestamps: true },
);
opportunity.index({ status: 1, dates: 1 });
opportunity.index({ organiserId: 1, createdAt: -1 });
export const MarketOpportunity = model('MarketOpportunity', opportunity);
const application = new Schema(
  {
    ownerId: ref,
    profileId: ref,
    opportunityId: { ...ref, ref: 'MarketOpportunity' },
    organiserId: ref,
    scopeKey: String,
    profile: new Schema(profileFields, { _id: false }),
    certificates: [{ type: Schema.Types.ObjectId }],
    note: String,
    status: {
      type: String,
      enum: ['pending', 'approved', 'declined'],
      default: 'pending',
    },
    active: { type: Boolean, default: true },
    message: String,
    paymentStatus: {
      type: String,
      enum: ['not_due', 'due', 'paid', 'refunded', 'waived'],
      default: 'not_due',
    },
    // Immutable commercial terms accepted at submission, unaffected by listing edits.
    terms: Schema.Types.Mixed,
  },
  { timestamps: true, optimisticConcurrency: true },
);
application.index(
  { profileId: 1, opportunityId: 1, scopeKey: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
application.index({ organiserId: 1, opportunityId: 1, scopeKey: 1, status: 1 });
application.index({ ownerId: 1, createdAt: -1 });
export const MarketApplication = model('MarketApplication', application);
const serviceListing = new Schema(
  {
    ownerId: ref,
    category: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    photos: [String],
    serviceArea: { type: String, required: true },
    availability: { type: String, required: true },
    pricing: { type: String, required: true },
    deliveryDetails: String,
    contactEmail: { type: String, required: true },
    status: { type: String, enum: ['draft', 'published'], default: 'draft' },
  },
  { timestamps: true },
);
serviceListing.index({ status: 1, category: 1, createdAt: -1 });
serviceListing.index({ ownerId: 1, createdAt: -1 });
export const MarketServiceListing = model(
  'MarketServiceListing',
  serviceListing,
);
export async function ensureMarketplaceIndexes() {
  await Promise.all(
    [
      MarketServiceListing,
      MarketProfile,
      MarketPreference,
      MarketCertificate,
      MarketOpportunity,
      MarketApplication,
    ].map((m) => m.createIndexes()),
  );
}
