import { Request } from 'express';
import { Event } from '@models/event.model';
import { ICommunity } from '@models/community.model';
import { HttpError } from '@utils/httpError.util';

/**
 * An organizer (vendor owner or sub-user) peeking at an event's community. The
 * community layer is buyer-first: a buyer joins, holds a Membership row and
 * posts. An organizer never becomes a member (Membership.buyerId is a required
 * Buyer FK) — instead they get a READ-ONLY peek of the events they manage,
 * gated by ownership rather than membership.
 */
export interface OrganizerViewer {
  vendorId: string;
  isSuperAdmin: boolean;
}

/**
 * Extract an organizer identity from a request whose token passed
 * authenticateCommunityViewer. Returns null for a buyer token — the caller
 * then falls back to the buyer (membership) path.
 */
export function organizerFromRequest(req: Request): OrganizerViewer | null {
  const u = (req as any).ticketsUser;
  if (u && (u.userType === 'vendor' || u.userType === 'sub-user') && u.vendorId) {
    return { vendorId: String(u.vendorId), isSuperAdmin: Boolean(u.isSuperAdmin) };
  }
  return null;
}

/**
 * Community -> event -> vendorId ownership walk (the throwing twin of
 * ModerationController.requireCommunityOwnership, which returns a bool for the
 * moderation flow). Super-admins bypass. Verifies against the Event, the source
 * of truth, rather than Community.vendorId (denormalized at creation).
 */
export async function assertOrganizerOwnsCommunity(
  community: ICommunity,
  organizer: OrganizerViewer
): Promise<void> {
  if (organizer.isSuperAdmin) return;
  const event = await Event.findById(community.eventId).select('vendorId');
  if (!event) throw new HttpError(404, 'Event not found');
  if (String(event.vendorId) !== organizer.vendorId) {
    throw new HttpError(403, 'You do not manage this event');
  }
}
