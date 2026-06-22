import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { ResellerAuthService } from '@services/resellerAuth.service';
import { ResellerSaleService } from '@services/resellerSale.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { EventService } from '@services/event.service';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';

export class ResellerController {
  /**
   * Authentication: Login with phone/email + password
   */
  static async login(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = Joi.object({
        identifier: Joi.string().required(),
        password: Joi.string().required(),
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const result = await ResellerAuthService.login(value.identifier, value.password);
      return ApiResponseUtil.success(res, result, 'Login successful');
    } catch (err: any) {
      console.error('Reseller login error:', err);
      return ApiResponseUtil.error(res, err.message || 'Login failed', 401);
    }
  }

  /**
   * Events: List published events platform-wide
   */
  static async getEvents(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
        search: Joi.string().optional().trim(),
        startDate: Joi.date().iso().optional(),
        endDate: Joi.date().iso().optional(),
      }).validate(req.query);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      // Resellers see all published events platform-wide — pass a dummy vendorId
      // and isSuperAdmin=true so EventService.getEvents skips vendor scoping.
      const result = await EventService.getEvents({
        vendorId: '',
        status: EventStatus.PUBLISHED,
        isSuperAdmin: true,
        ...value,
      });

      return ApiResponseUtil.success(res, result);
    } catch (err: any) {
      console.error('Reseller get events error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to fetch events');
    }
  }

  /**
   * Events: Get ticket types + remaining capacity for a single event
   */
  static async getEventTickets(req: Request, res: Response): Promise<any> {
    try {
      const { id } = req.params;

      // getEventById with isSuperAdmin=true so we can see any event by id
      const event = await EventService.getEventById(id as string, '', true);

      if (event.status !== EventStatus.PUBLISHED) {
        return ApiResponseUtil.error(res, 'Event is not published', 404);
      }

      // Shape ticket types with remaining capacity for the POS
      const ticketTypes = (event.ticketTypes || []).map((tt: any) => ({
        id: tt._id,
        name: tt.name,
        description: tt.description,
        price: tt.price,
        quantity: tt.quantity,
        sold: tt.sold,
        reserved: tt.reserved || 0,
        remaining: Math.max(0, tt.quantity - tt.sold - (tt.reserved || 0)),
        isSoldOut: tt.isSoldOut || false,
      }));

      return ApiResponseUtil.success(res, { event: { id: event._id, name: event.name, venue: event.venue, eventDate: event.eventDate }, ticketTypes });
    } catch (err: any) {
      console.error('Reseller get event tickets error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to fetch event tickets', 404);
    }
  }

  /**
   * Payment Methods: Return enabled methods from PaymentConfigService
   */
  static async getPaymentMethods(req: Request, res: Response): Promise<any> {
    try {
      const cfg = await PaymentConfigService.get();

      const methods: string[] = [];
      if (cfg.cashEnabled) methods.push('cash');
      if (cfg.mtnMomoEnabled) methods.push('mtn_momo');
      if (cfg.keshlessWalletEnabled) methods.push('keshless_wallet');

      return ApiResponseUtil.success(res, { methods });
    } catch (err: any) {
      console.error('Reseller get payment methods error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to fetch payment methods');
    }
  }

  /**
   * Sales: Create a POS sale — operatorId/resellerId/hubId from req.reseller only
   */
  static async createSale(req: Request, res: Response): Promise<any> {
    try {
      const reseller = (req as any).reseller;

      const { error, value } = Joi.object({
        eventId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
        ticketTypeId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
        quantity: Joi.number().integer().min(1).max(20).required(),
        paymentMethod: Joi.string().valid('cash', 'mtn_momo', 'keshless_wallet').required(),
        customerName: Joi.string().optional().max(100).trim().allow(''),
        customerPhone: Joi.string().optional().trim().allow(''),
        keshlessCardNumber: Joi.string().optional().length(8).alphanum().uppercase(),
        keshlessPin: Joi.string().optional().length(4).pattern(/^\d{4}$/),
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const result = await ResellerSaleService.createSale({
        // Trust ONLY values from the verified JWT — never client-supplied ids
        operatorId: reseller.operatorId,
        resellerId: reseller.resellerId,
        hubId: reseller.hubId ?? '',
        ...value,
      });

      return ApiResponseUtil.created(res, result, result.message || 'Sale completed');
    } catch (err: any) {
      console.error('Reseller create sale error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to create sale');
    }
  }

  /**
   * Sales: List own sales scoped to req.reseller.operatorId + resellerId
   */
  static async getSales(req: Request, res: Response): Promise<any> {
    try {
      const reseller = (req as any).reseller;

      const { error, value } = Joi.object({
        page: Joi.number().integer().min(1).default(1),
        limit: Joi.number().integer().min(1).max(100).default(20),
        startDate: Joi.date().iso().optional(),
        endDate: Joi.date().iso().optional(),
      }).validate(req.query);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const { page = 1, limit = 20, startDate, endDate } = value;

      // Scope strictly to this operator's own sales — never trust client-supplied ids
      const filter: any = {
        soldBy: reseller.operatorId,
        soldByType: 'ResellerOperator',
        resellerId: reseller.resellerId,
      };

      if (startDate || endDate) {
        filter.soldAt = {};
        if (startDate) filter.soldAt.$gte = startDate;
        if (endDate) filter.soldAt.$lte = endDate;
      }

      const skip = (page - 1) * limit;
      const [sales, total] = await Promise.all([
        TicketSale.find(filter)
          .populate('eventId', 'name venue eventDate')
          .sort({ soldAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        TicketSale.countDocuments(filter),
      ]);

      return ApiResponseUtil.success(res, {
        data: sales,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1,
        },
      });
    } catch (err: any) {
      console.error('Reseller get sales error:', err);
      return ApiResponseUtil.error(res, err.message || 'Failed to fetch sales');
    }
  }
}
