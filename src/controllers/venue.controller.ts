import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { VenueService } from '@services/venue.service';

/** The signed-in vendor's own venue (venue trading spec, Phase 1). */
export class VenueController {
  /**
   * GET /api/tickets/venue → { venue: VenueSummary | null, eligible }
   * Resolved by the token's vendorId, so a sub-user sees their vendor's venue.
   */
  static async mine(req: Request, res: Response): Promise<any> {
    const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
    if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor session required');
    try {
      return ApiResponseUtil.success(res, await VenueService.forVendor(String(vendorId)));
    } catch (e: any) {
      console.error('Get my venue error:', e);
      return ApiResponseUtil.error(res, e.message || 'Failed to load venue', 500);
    }
  }
}
