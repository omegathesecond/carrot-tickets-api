import { Request, Response } from 'express';
import Joi from 'joi';
import { cartItemsSchema, couponCodeSchema } from '@validators/checkout.validator';
import { EventCouponService } from '@services/eventCoupon.service';
import { resolveCart } from '@services/cart.service';
import { PaymentMethod, SalesChannel } from '@interfaces/ticket.interface';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, requireRouteParam } from '@utils/controllerHelpers.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';

const createSchema = Joi.object({
  count: Joi.number().integer().min(1).max(100).default(1),
  label: Joi.string().trim().max(100).allow('').default(''),
  discountType: Joi.string().valid('percentage', 'fixed').required(),
  discountValue: Joi.number().positive().required(),
  ticketTypeIds: Joi.array().items(Joi.string().hex().length(24)).max(100).unique().default([]),
  expiresAt: Joi.date().iso().greater('now').optional(),
});
const quoteSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  couponCode: couponCodeSchema.required(),
  items: cartItemsSchema.required(),
  method: Joi.string().valid(...Object.values(PaymentMethod)).required(),
});

export class EventCouponController {
  static async create(req: Request, res: Response): Promise<any> {
    const { error, value } = createSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const vendorId = (req as any).ticketsUser?.vendorId;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const coupons = await EventCouponService.create(requireRouteParam(req, 'eventId'), String(vendorId), value);
      return ApiResponseUtil.created(res, { coupons }, 'Single-use coupons generated');
    } catch (error) { return failWithHttpError(res, error, 'Could not generate coupons'); }
  }

  static async list(req: Request, res: Response): Promise<any> {
    const { error, value } = Joi.object({ page: Joi.number().integer().min(1).max(100000).default(1) }).validate(req.query);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const vendorId = (req as any).ticketsUser?.vendorId;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      return ApiResponseUtil.success(res, await EventCouponService.list(requireRouteParam(req, 'eventId'), String(vendorId), value.page));
    } catch (error) { return failWithHttpError(res, error, 'Could not load coupons'); }
  }

  static async disable(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = (req as any).ticketsUser?.vendorId;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');
      const coupon = await EventCouponService.disable(requireRouteParam(req, 'eventId'), String(vendorId), requireRouteParam(req, 'couponId'));
      return ApiResponseUtil.success(res, { coupon });
    } catch (error) { return failWithHttpError(res, error, 'Could not disable coupon'); }
  }

  static async quote(req: Request, res: Response): Promise<any> {
    const { error, value } = quoteSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to use a coupon');
      const cart = await resolveCart({ ...value, buyerId: String(buyer._id), phone: buyer.phone, channel: SalesChannel.ONLINE });
      return ApiResponseUtil.success(res, { code: cart.coupon!.code, discountAmount: cart.coupon!.discountAmount,
        originalAmount: cart.coupon!.originalAmount, ticketTypeId: cart.coupon!.ticketTypeId,
        subtotal: cart.faceTotal, serviceFeeAmount: cart.serviceFeeAmount, amountCharged: cart.amountCharged });
    } catch (error) { return failWithHttpError(res, error, 'Could not apply coupon'); }
  }
}
