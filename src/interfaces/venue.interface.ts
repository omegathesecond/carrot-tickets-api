import { Document, Types } from 'mongoose';
import { EventCurrency } from '@utils/currency.util';

export type VenueStatus = 'active' | 'suspended';

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
  /** A venue trades in one of the same two currencies an event can. */
  currency: EventCurrency;
  status: VenueStatus;
  activatedAt: Date;
  /** The acting super-admin's `vendorId ?? userId` from their token (a platform gate-operator has only a userId), kept as a string. */
  activatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What the dashboard (own venue) and the admin Organizers list are told. */
export interface VenueSummary {
  id: string;
  name: string;
  currency: EventCurrency;
  status: VenueStatus;
  activatedAt: Date;
}
