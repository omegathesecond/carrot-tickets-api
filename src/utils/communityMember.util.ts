import type { SocialActor } from '@utils/socialActor.util';

/**
 * The Membership identity fields for a social actor — a buyer XOR an organizer
 * brand (Vendor). Used both as a `findOne` filter and as the create payload,
 * so a lookup and its matching insert can never disagree about which field
 * carries the member id. Mirrors the polymorphic member shape enforced by
 * membership.model.ts's pre-validate XOR.
 */
export function memberKey(actor: SocialActor): { buyerId: string } | { vendorId: string } {
  return actor.type === 'vendor' ? { vendorId: actor.id } : { buyerId: actor.id };
}
