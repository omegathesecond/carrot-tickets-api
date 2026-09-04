// api/src/controllers/cashlessReconciliation.controller.ts
import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { ReconciliationService } from '@services/reconciliation.service';
import { loadOwnedCashlessEvent } from '@controllers/organizerCashless.controller';

/**
 * Super-admin view of the cashless ledger's internal reconciliation checks.
 *
 * Distinct from OrganizerCashlessController on purpose: those routes are an
 * organizer's own reporting surface, while this exposes journal internals
 * (unbalanced txnIds, per-wallet drift) that only platform staff should read.
 * The route is gated by requireSuperAdmin; the shared event guard is reused so
 * a missing or non-cashless event answers the same way as the organizer routes.
 */
export class CashlessReconciliationController {
  /** GET /api/tickets/events/:eventId/cashless/reconciliation */
  static async get(req: Request, res: Response): Promise<any> {
    try {
      const eventId = String(req.params['eventId']);
      const event = await loadOwnedCashlessEvent(req, res, eventId);
      if (!event) return;
      const report = await ReconciliationService.checkEvent(eventId);
      return ApiResponseUtil.success(res, { event: { id: String(event._id), name: event.name }, ...report });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e?.message || 'Failed to reconcile cashless ledger', 500);
    }
  }
}
