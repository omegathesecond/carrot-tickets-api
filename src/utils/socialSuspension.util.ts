import { IBuyer } from '@models/buyer.model';
import { HttpError } from '@utils/httpError.util';

/**
 * Platform-wide social suspension gate (Plan 7 Task 3). A Carrot admin can
 * suspend a buyer's community access while resolving a report (see
 * ReportService.resolve's suspend_buyer action) — every social WRITE path
 * must reject a suspended buyer with the same 403.
 *
 * Wired into channel message send, DM message send, DM thread create,
 * review create, follow create, community join, event-question create/
 * reply/like (via eventQuestion.service's assertActorNotSuspended, buyer
 * actors only), and Story create (gated in story.controller). Deliberately
 * NOT wired into reads, ticket lookup/QR/purchase — suspension blocks
 * community participation, not access to tickets already bought.
 */
export function assertNotSuspended(buyer: IBuyer): void {
  if (buyer.socialSuspendedAt) {
    throw new HttpError(403, 'Your community access is suspended');
  }
}
