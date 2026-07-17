import { Request } from 'express';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';

export type SocialActorType = 'buyer' | 'vendor';

/** The identity acting on the social graph — a ticket-buyer or an organizer brand (Vendor). */
export interface SocialActor {
  type: SocialActorType;
  id: string;
}

/**
 * Resolve the acting social identity from a verified tickets token.
 * Vendor and sub-user tokens both carry `vendorId` — the brand is the actor.
 * Buyer tokens carry `userPhone`, resolved to the Buyer document id.
 * Returns null when unauthenticated or when a buyer token has no Buyer row yet.
 */
export async function resolveActorFromRequest(req: Request): Promise<SocialActor | null> {
  const user = (req as any).ticketsUser;
  if (!user) return null;
  if (user.vendorId) return { type: 'vendor', id: String(user.vendorId) };
  if (user.userType === 'buyer' && user.userPhone) {
    const buyer = await resolveBuyerFromRequest(req);
    if (buyer) return { type: 'buyer', id: String(buyer._id) };
  }
  return null;
}

/**
 * Does `actor` own content authored by (authorType, authorId)?
 *
 * The ONE ownership rule — used by UpdateController.remove() (can you delete
 * this?) and by the viewerIsAuthor flag (should the UI offer delete?). Those
 * two must never disagree, so they share this.
 *
 * The authorType clause is load-bearing, not cosmetic: comparing ids alone let
 * a buyer whose _id equalled a vendor's id delete that brand's post (a test
 * constructs exactly that collision).
 *
 * Callers speaking a different vocabulary must translate FIRST — notably the
 * feed, whose FeedAuthor.type is 'organizer' where the model says 'vendor'.
 */
export function isActorAuthorOf(
  authorType: string | undefined,
  authorId: unknown,
  actor: SocialActor | null | undefined,
): boolean {
  return !!actor && authorType === actor.type && String(authorId) === String(actor.id);
}
