import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { TripService } from '@services/transport/trip.service';
import { BookingService } from '@services/transport/booking.service';
import {
  listTripsQuerySchema, sellSeatSchema, boardSchema,
  initiateMomoBookingSchema, initiateCardBookingSchema,
} from '@validators/transportPos.validator';

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

      // Reseller lookup + suspension guard + commission resolution now live
      // in BookingService.sellSeat (mirrors ResellerSaleService's convention).
      const result = await BookingService.sellSeat({
        ...value,
        soldBy: r.operatorId,
        soldByType: 'reseller-operator',
        resellerId: r.resellerId,
        hubId: r.hubId,
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

  static async sellMomo(req: Request, res: Response): Promise<any> {
    try {
      const r = reseller(req);
      if (!r) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const { error, value } = initiateMomoBookingSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);

      // Reseller lookup + suspension guard + commission resolution live in
      // BookingService.initiateMomoBooking (mirrors sellSeat's convention).
      const { referenceId, saleId, expiresAt } = await BookingService.initiateMomoBooking({
        ...value,
        soldBy: r.operatorId,
        soldByType: 'reseller-operator',
        resellerId: r.resellerId,
        hubId: r.hubId,
      });
      return ApiResponseUtil.created(res, { referenceId, saleId, expiresAt }, 'MoMo booking initiated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to initiate MoMo booking'); }
  }

  static async sellCard(req: Request, res: Response): Promise<any> {
    try {
      const r = reseller(req);
      if (!r) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const { error, value } = initiateCardBookingSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);

      const { paymentId, redirectUrl, saleId, expiresAt } = await BookingService.initiateCardBooking({
        ...value,
        soldBy: r.operatorId,
        soldByType: 'reseller-operator',
        resellerId: r.resellerId,
        hubId: r.hubId,
      });
      return ApiResponseUtil.created(res, { paymentId, redirectUrl, saleId, expiresAt }, 'Card booking initiated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to initiate card booking'); }
  }

  static async momoStatus(req: Request, res: Response): Promise<any> {
    try {
      const r = reseller(req);
      if (!r) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const referenceId = String(req.params['referenceId']);

      // Ownership check: the sale's resellerId must match the calling
      // reseller — prevents one reseller from polling another's booking
      // status. Mirrors public.controller's getMomoStatus (phone-scoped).
      // Missing/mismatched sale -> 404 (don't reveal existence).
      const sale = await BookingService.getMomoBookingSaleByReference(referenceId);
      if (!sale || (sale.resellerId ? sale.resellerId.toString() !== r.resellerId : true)) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }

      // Poll = re-run finalize (idempotent + pending-safe), matching how the
      // events SPA polls via finalize.
      const result = await BookingService.finalizeMomoBooking(referenceId);
      return ApiResponseUtil.success(res, result);
    } catch (e) { return failWithHttpError(res, e, 'Failed to check MoMo booking status'); }
  }

  static async cardStatus(req: Request, res: Response): Promise<any> {
    try {
      const r = reseller(req);
      if (!r) return ApiResponseUtil.unauthorized(res, 'Reseller sign-in required');
      const paymentId = String(req.params['paymentId']);

      // Same ownership check as momoStatus, keyed on peachPaymentId.
      const sale = await BookingService.getCardBookingSaleByPaymentId(paymentId);
      if (!sale || (sale.resellerId ? sale.resellerId.toString() !== r.resellerId : true)) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }

      const result = await BookingService.finalizeCardBooking(paymentId);
      return ApiResponseUtil.success(res, result);
    } catch (e) { return failWithHttpError(res, e, 'Failed to check card booking status'); }
  }
}
