import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { VehicleTypeService } from '@services/transport/vehicleType.service';
import { RouteService } from '@services/transport/route.service';
import { TripService } from '@services/transport/trip.service';
import {
  createVehicleTypeSchema, updateVehicleTypeSchema,
  createRouteSchema, updateRouteSchema,
  createTripSchema, reserveSeatSchema, reservedCountSchema, listTripsQuerySchema,
} from '@validators/transport.validator';

function vendorId(req: Request): string | undefined {
  return (req as any).ticketsUser?.vendorId;
}

export class TransportController {
  // ── Vehicle types ──────────────────────────────────────────────
  static async createVehicleType(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = createVehicleTypeSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      const vt = await VehicleTypeService.create({ vendorId: vid, ...value });
      return ApiResponseUtil.created(res, vt, 'Vehicle type created');
    } catch (e) { return failWithHttpError(res, e, 'Failed to create vehicle type'); }
  }

  static async listVehicleTypes(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      return ApiResponseUtil.success(res, await VehicleTypeService.list(vid));
    } catch (e) { return failWithHttpError(res, e, 'Failed to list vehicle types'); }
  }

  static async updateVehicleType(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = updateVehicleTypeSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      const vt = await VehicleTypeService.update(vid, String(req.params['id']), value);
      return ApiResponseUtil.success(res, vt, 'Vehicle type updated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to update vehicle type'); }
  }

  static async deleteVehicleType(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      await VehicleTypeService.deactivate(vid, String(req.params['id']));
      return ApiResponseUtil.success(res, { deactivated: true }, 'Vehicle type deactivated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to deactivate vehicle type'); }
  }

  // ── Routes ─────────────────────────────────────────────────────
  static async createRoute(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = createRouteSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.created(res, await RouteService.create({ vendorId: vid, ...value }), 'Route created');
    } catch (e) { return failWithHttpError(res, e, 'Failed to create route'); }
  }

  static async listRoutes(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      return ApiResponseUtil.success(res, await RouteService.list(vid));
    } catch (e) { return failWithHttpError(res, e, 'Failed to list routes'); }
  }

  static async updateRoute(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = updateRouteSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.success(res, await RouteService.update(vid, String(req.params['id']), value), 'Route updated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to update route'); }
  }

  static async deleteRoute(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      await RouteService.deactivate(vid, String(req.params['id']));
      return ApiResponseUtil.success(res, { deactivated: true }, 'Route deactivated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to deactivate route'); }
  }

  // ── Trips ──────────────────────────────────────────────────────
  static async createTrip(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = createTripSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.created(res, await TripService.createTrip({ vendorId: vid, ...value }), 'Trip created');
    } catch (e) { return failWithHttpError(res, e, 'Failed to create trip'); }
  }

  static async listTrips(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = listTripsQuerySchema.validate(req.query);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.success(res, await TripService.listSellable({ vendorId: vid, routeId: value.routeId }));
    } catch (e) { return failWithHttpError(res, e, 'Failed to list trips'); }
  }

  static async getTrip(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      return ApiResponseUtil.success(res, await TripService.getWithAvailability(vid, String(req.params['id'])));
    } catch (e) { return failWithHttpError(res, e, 'Failed to load trip'); }
  }

  static async reserveSeat(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = reserveSeatSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      await TripService.reserveSeat(vid, String(req.params['id']), String(req.params['seatNumber']), value.note, (req as any).ticketsUser?.userId);
      return ApiResponseUtil.success(res, { reserved: true }, 'Seat reserved');
    } catch (e) { return failWithHttpError(res, e, 'Failed to reserve seat'); }
  }

  static async releaseSeat(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      await TripService.releaseSeat(vid, String(req.params['id']), String(req.params['seatNumber']));
      return ApiResponseUtil.success(res, { reserved: false }, 'Seat released');
    } catch (e) { return failWithHttpError(res, e, 'Failed to release seat'); }
  }

  static async setReservedCount(req: Request, res: Response): Promise<any> {
    try {
      const vid = vendorId(req);
      if (!vid) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = reservedCountSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      return ApiResponseUtil.success(res, await TripService.setReservedCount(vid, String(req.params['id']), value.reservedCount), 'Reserved count updated');
    } catch (e) { return failWithHttpError(res, e, 'Failed to set reserved count'); }
  }
}
