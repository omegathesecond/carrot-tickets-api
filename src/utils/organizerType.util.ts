import mongoose from 'mongoose';
import { OperatorType } from '@interfaces/vendor.interface';

/**
 * The account TYPE of a vendor, as the super-admin Organizers list groups them.
 *
 * Exactly one per account, by the FIRST rule that matches:
 *   1. services  - operatorType is 'services'
 *   2. venues    - businessType is 'venue' OR the vendor has a Venue record
 *                  (any status)
 *   3. transport - operatorType is 'transport'
 *   4. events    - everything else ('events', 'both', or no operatorType)
 *
 * The rules live in ONE ordered list (PRECEDENCE) and each rule is written as a
 * pair - a JS test and its Mongo filter - side by side. Classifying a row
 * (organizerTypeOf) and selecting a type (organizerTypeFilter) both read that
 * list, and the filter derives "and nothing outranks it" from the list's
 * order, so the two cannot disagree about precedence.
 */
export const ORGANIZER_TYPES = ['events', 'venues', 'services', 'transport'] as const;
export type OrganizerType = (typeof ORGANIZER_TYPES)[number];

/** Vendor ids that have a Venue record, as hex strings. Build once per request. */
export type VenueVendorIds = ReadonlySet<string>;

/** The few Vendor fields the rules read. Absent/null means the field is unset. */
export interface OrganizerTypeFacts {
  _id: unknown;
  operatorType?: string | null;
  businessType?: string | null;
}

type MongoFilter = Record<string, unknown>;

const VENUE_BUSINESS_TYPE = 'venue';

interface Rule {
  type: Exclude<OrganizerType, 'events'>;
  test: (vendor: OrganizerTypeFacts, venueVendorIds: VenueVendorIds) => boolean;
  match: (venueObjectIds: mongoose.Types.ObjectId[]) => MongoFilter;
}

/** Highest precedence first. `events` is not listed: it is whatever none of these match. */
const PRECEDENCE: readonly Rule[] = [
  {
    type: 'services',
    test: (v) => v.operatorType === OperatorType.SERVICES,
    match: () => ({ operatorType: OperatorType.SERVICES }),
  },
  {
    type: 'venues',
    test: (v, venueVendorIds) => v.businessType === VENUE_BUSINESS_TYPE || venueVendorIds.has(String(v._id)),
    match: (venueObjectIds) => ({ $or: [{ businessType: VENUE_BUSINESS_TYPE }, { _id: { $in: venueObjectIds } }] }),
  },
  {
    type: 'transport',
    test: (v) => v.operatorType === OperatorType.TRANSPORT,
    match: () => ({ operatorType: OperatorType.TRANSPORT }),
  },
];

/** Which type one vendor row is. */
export function organizerTypeOf(vendor: OrganizerTypeFacts, venueVendorIds: VenueVendorIds): OrganizerType {
  return PRECEDENCE.find((rule) => rule.test(vendor, venueVendorIds))?.type ?? 'events';
}

/**
 * The Mongo filter selecting exactly the vendors `organizerTypeOf` calls `type`.
 * Works in find / countDocuments AND aggregate $match: ids are cast to ObjectId
 * here because aggregate() does not cast. It uses `$and` / `$or` / `$nor`
 * internally, so callers must compose it with other conditions through their
 * own `$and`, never by spreading it next to another `$or`.
 */
export function organizerTypeFilter(type: OrganizerType, venueVendorIds: VenueVendorIds): MongoFilter {
  const rank = PRECEDENCE.findIndex((rule) => rule.type === type);
  if (rank === -1 && type !== 'events') throw new Error(`Unknown organizer type: ${String(type)}`);

  const venueObjectIds = [...venueVendorIds].map((id) => new mongoose.Types.ObjectId(id));
  const outranking = (rank === -1 ? PRECEDENCE : PRECEDENCE.slice(0, rank)).map((rule) => rule.match(venueObjectIds));

  const clauses: MongoFilter[] = [];
  if (rank !== -1) clauses.push(PRECEDENCE[rank]!.match(venueObjectIds));
  if (outranking.length) clauses.push({ $nor: outranking });
  return { $and: clauses };
}
