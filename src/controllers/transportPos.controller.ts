import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { TripService } from '@services/transport/trip.service';
import { BookingService } from '@services/transport/booking.service';
import { Reseller } from '@models/reseller.model';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { listTripsQuerySchema, sellSeatSchema, boardSchema } from '@validators/transportPos.validator';

function reseller(req: Request): { operatorId: string; resellerId: string; hubId?: string } | undefined {
  return (req as any).reseller;
}

export class TransportPosController {
  static async listTrips(req: Request, res: Response): Promise<any> {
    try {
      if (!reseller(req)) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const { error, value } = listTripsQuerySchema.validate(req.query);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      // Resellers browse trips platform-wide (mirrors reseller event browsing).
      return ApiResponseUtil.success(res, await TripService.listSellable({ vendorId: value.vendorId, routeId: value.routeId }));
    } catch (e) { return failWithHttpError(res, e, 'Failed to list trips'); }
  }

  static async getTrip(req: Request, res: Response): Promise<any> {
    try {
      if (!reseller(req)) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      // isSuperAdmin=true → not vendor-scoped, so a reseller can view any vendor's trip.
      return ApiResponseUtil.success(res, await TripService.getWithAvailability('', String(req.params['id']), true));
    } catch (e) { return failWithHttpError(res, e, 'Failed to load trip'); }
  }

  static async sell(req: Request, res: Response): Promise<any> {
    try {
      const r = reseller(req);
      if (!r) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const { error, value } = sellSeatSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);

      const resellerDoc = await Reseller.findById(r.resellerId).select('commissionPercent');
      const cfg = await PaymentConfigService.get();
      const commissionPercent = resellerDoc?.commissionPercent ?? cfg.defaultResellerCommissionPercent;

      const result = await BookingService.sellSeat({
        ...value,
        soldBy: r.operatorId,
        soldByType: 'reseller-operator',
        resellerId: r.resellerId,
        hubId: r.hubId,
        resellerCommissionPercent: commissionPercent,
      });
      return ApiResponseUtil.created(res, result, 'Booking sold');
    } catch (e) { return failWithHttpError(res, e, 'Failed to sell seat'); }
  }

  static async board(req: Request, res: Response): Promise<any> {
    try {
      const r = reseller(req);
      if (!r) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const { error, value } = boardSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      const result = await BookingService.board({ qrCode: value.qrCode, tripId: value.tripId, scannedBy: r.operatorId, scannedByType: 'ResellerOperator' });
      return ApiResponseUtil.success(res, result, 'Scan recorded');
    } catch (e) { return failWithHttpError(res, e, 'Failed to record boarding scan'); }
  }
}
