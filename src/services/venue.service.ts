import mongoose from 'mongoose';
import { Venue } from '@models/venue.model';
import { Vendor } from '@models/vendor.model';
import { IVenue, VenueCurrency, VenueStatus, VenueSummary } from '@interfaces/venue.interface';

/** A second switch-on for a vendor that already has a venue. Mapped to 409. */
export class VenueAlreadyExistsError extends Error {
  constructor() {
    super('This vendor already has a venue');
    this.name = 'VenueAlreadyExistsError';
  }
}

/** No such vendor — or the platform super-admin account, which is never a venue. Mapped to 404. */
export class VenueVendorNotFoundError extends Error {
  constructor() {
    super('Vendor not found');
    this.name = 'VenueVendorNotFoundError';
  }
}

/** No such venue. Mapped to 404. */
export class VenueNotFoundError extends Error {
  constructor() {
    super('Venue not found');
    this.name = 'VenueNotFoundError';
  }
}

export function toVenueSummary(
  v: Pick<IVenue, '_id' | 'name' | 'currency' | 'status' | 'activatedAt'>,
): VenueSummary {
  return { id: String(v._id), name: v.name, currency: v.currency, status: v.status, activatedAt: v.activatedAt };
}

export class VenueService {
  static async activate(params: {
    vendorId: string;
    name: string;
    currency: VenueCurrency;
    activatedBy: string;
  }): Promise<IVenue> {
    if (!mongoose.isValidObjectId(params.vendorId)) throw new VenueVendorNotFoundError();
    const vendor = await Vendor.findOne({ _id: params.vendorId, isSuperAdmin: { $ne: true } }).select('_id').lean();
    if (!vendor) throw new VenueVendorNotFoundError();
    try {
      return await Venue.create({
        vendorId: vendor._id,
        name: params.name,
        currency: params.currency,
        status: 'active',
        activatedAt: new Date(),
        activatedBy: params.activatedBy,
      });
    } catch (e) {
      // The unique vendorId index is the ONLY guard against a concurrent
      // second switch-on — see venue.model.ts.
      if ((e as { code?: number })?.code === 11000) throw new VenueAlreadyExistsError();
      throw e;
    }
  }

  static async setStatus(venueId: string, status: VenueStatus): Promise<IVenue> {
    if (!mongoose.isValidObjectId(venueId)) throw new VenueNotFoundError();
    const venue = await Venue.findByIdAndUpdate(venueId, { $set: { status } }, { new: true });
    if (!venue) throw new VenueNotFoundError();
    return venue;
  }

  /**
   * The signed-in vendor's venue, and whether the dashboard's Venue section
   * applies at all: a venue-type account (waiting to be switched on), or ANY
   * account that has a venue (an admin may switch one on for an organizer).
   *
   * A vendorId that is not an ObjectId cannot own a venue — answered as "no
   * venue", which is the truth, rather than letting the cast throw a 500.
   */
  static async forVendor(vendorId: string): Promise<{ venue: VenueSummary | null; eligible: boolean }> {
    if (!mongoose.isValidObjectId(vendorId)) return { venue: null, eligible: false };
    const [venue, vendor] = await Promise.all([
      Venue.findOne({ vendorId }).lean<IVenue | null>(),
      Vendor.findById(vendorId).select('businessType').lean<{ businessType?: string } | null>(),
    ]);
    return {
      venue: venue ? toVenueSummary(venue) : null,
      eligible: !!venue || vendor?.businessType === 'venue',
    };
  }

  /** Venue summaries for a page of vendors, keyed by vendorId string. */
  static async summariesFor(vendorIds: mongoose.Types.ObjectId[]): Promise<Map<string, VenueSummary>> {
    if (!vendorIds.length) return new Map();
    const venues = await Venue.find({ vendorId: { $in: vendorIds } }).lean<IVenue[]>();
    return new Map(venues.map((v) => [String(v.vendorId), toVenueSummary(v)]));
  }
}
