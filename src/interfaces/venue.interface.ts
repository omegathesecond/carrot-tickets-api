import { Document, Types } from 'mongoose';

export type VenueStatus = 'active' | 'suspended';
export type VenueCurrency = 'SZL' | 'ZAR';

/**
 * A vendor's day-to-day trading premises (venue trading spec). Created ONLY by
 * a super-admin switching venue trading on — there is no self-serve path,
 * because Carrot bills venues off-platform and the switch is the commercial
 * gate. One per vendor in v1 (unique vendorId); a second location later is a
 * second Venue, not a schema change.
 *
 * Deliberately NOT fields on Vendor: the Vendor is the social actor (posts,
 * follows, DMs); trading settings belong to the premises.
 */
export interface IVenue extends Document {
  _id: Types.ObjectId;
  vendorId: Types.ObjectId;
  name: string;
  currency: VenueCurrency;
  status: VenueStatus;
  activatedAt: Date;
  /** The super-admin's vendorId from their token, kept as a string. */
  activatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What the dashboard (own venue) and the admin Organizers list are told. */
export interface VenueSummary {
  id: string;
  name: string;
  currency: VenueCurrency;
  status: VenueStatus;
  activatedAt: Date;
}
