import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketService } from '@services/ticket.service';
import { SalesChannel } from '@interfaces/ticket.interface';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { normalizePhone } from '@utils/phone.util';
import { PaymentConfigService } from '@services/paymentConfig.service';

// Validation schema for MTN MoMo purchase initiation
const momoInitiateSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  ticketTypeId: Joi.string().hex().length(24).required(),
  quantity: Joi.number().integer().min(1).max(10).required(),
  customerName: Joi.string().max(100).optional(),
  momoPhone: Joi.string().pattern(/^[0-9]{8,15}$/).required(),
});

// Validation schemas
const publicEventsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  search: Joi.string().optional().max(100),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional().min(Joi.ref('startDate'))
});

const publicPurchaseSchema = Joi.object({
  eventId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
  ticketTypeId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
  quantity: Joi.number().integer().min(1).max(10).required(),
  // The buyer's phone is NO LONGER taken from the body — it comes from the
  // OTP-verified buyer token (req.ticketsUser.userPhone). This guarantees
  // every ticket is tied to a phone the buyer actually controls, so it always
  // surfaces under "My Tickets" for that number. Name stays optional for
  // personalising the printed ticket.
  customerName: Joi.string().optional().max(100).trim().allow(''),
  keshlessCardNumber: Joi.string().required().length(8).alphanum().uppercase(),
  keshlessPin: Joi.string().optional().length(4).pattern(/^\d{4}$/)
});

export class PublicController {
  /**
   * Get all published events (no auth required)
   */
  static async getPublicEvents(req: Request, res: Response): Promise<any> {
    try {
      // Validate query
      const { error, value } = publicEventsQuerySchema.validate(req.query);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const { page, limit, search, startDate, endDate } = value;

      // Build query - only published events
      const filter: any = {
        status: EventStatus.PUBLISHED
      };

      // Filter by date range
      if (startDate || endDate) {
        filter.eventDate = {};
        if (startDate) filter.eventDate.$gte = new Date(startDate);
        if (endDate) filter.eventDate.$lte = new Date(endDate);
      } else {
        // Default: only show upcoming events (eventDate >= today)
        filter.eventDate = { $gte: new Date() };
      }

      // Search by name, venue, or description
      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: 'i' } },
          { venue: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }

      // Execute query with pagination
      const skip = (page - 1) * limit;
      const [events, total] = await Promise.all([
        Event.find(filter)
          .select('name description venue eventDate startTime endTime posterUrl thumbnailUrl ticketTypes capacity totalTicketsSold')
          .sort({ eventDate: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Event.countDocuments(filter)
      ]);

      // Transform events for public display
      const publicEvents = events.map(event => ({
        _id: event._id,
        name: event.name,
        description: event.description,
        venue: event.venue,
        eventDate: event.eventDate,
        startTime: event.startTime,
        endTime: event.endTime,
        posterUrl: event.posterUrl,
        thumbnailUrl: event.thumbnailUrl,
        ticketTypes: event.ticketTypes.map(tt => ({
          _id: tt._id,
          name: tt.name,
          description: tt.description,
          price: tt.price,
          available: tt.available,
          isSoldOut: tt.isSoldOut || tt.available === 0
        })),
        isSoldOut: event.ticketTypes.every(tt => tt.isSoldOut || tt.available === 0),
        priceRange: {
          min: Math.min(...event.ticketTypes.map(tt => tt.price)),
          max: Math.max(...event.ticketTypes.map(tt => tt.price))
        }
      }));

      return ApiResponseUtil.success(res, {
        events: publicEvents,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      });
    } catch (error: any) {
      console.error('Get public events error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch events');
    }
  }

  /**
   * Get single published event by ID (no auth required)
   */
  static async getPublicEvent(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;

      // Validate eventId format
      if (!eventId || !eventId.match(/^[0-9a-fA-F]{24}$/)) {
        return ApiResponseUtil.error(res, 'Invalid event ID format', 400);
      }

      const event = await Event.findOne({
        _id: eventId,
        status: EventStatus.PUBLISHED
      }).lean();

      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found or not available');
      }

      // Transform for public display
      const publicEvent = {
        _id: event._id,
        name: event.name,
        description: event.description,
        venue: event.venue,
        eventDate: event.eventDate,
        startTime: event.startTime,
        endTime: event.endTime,
        isMultiDay: event.isMultiDay,
        posterUrl: event.posterUrl,
        thumbnailUrl: event.thumbnailUrl,
        galleryImages: event.galleryImages,
        ticketTypes: event.ticketTypes.map(tt => ({
          _id: tt._id,
          name: tt.name,
          description: tt.description,
          price: tt.price,
          available: tt.available,
          isSoldOut: tt.isSoldOut || tt.available === 0
        })),
        isSoldOut: event.ticketTypes.every(tt => tt.isSoldOut || tt.available === 0),
        priceRange: {
          min: Math.min(...event.ticketTypes.map(tt => tt.price)),
          max: Math.max(...event.ticketTypes.map(tt => tt.price))
        }
      };

      return ApiResponseUtil.success(res, publicEvent);
    } catch (error: any) {
      console.error('Get public event error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch event');
    }
  }

  /**
   * Purchase tickets (public - no auth required, uses Keshless card payment)
   */
  static async purchaseTickets(req: Request, res: Response): Promise<any> {
    try {
      // Validate input
      const { error, value } = publicPurchaseSchema.validate(req.body);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const {
        eventId,
        ticketTypeId,
        quantity,
        keshlessCardNumber,
        keshlessPin
      } = value;

      // The buyer is authenticated (authenticateBuyer middleware), so their
      // phone is already OTP-verified and carried on the token. We trust THAT,
      // never a client-supplied value — the ticket is bound to the number they
      // proved they own, so it always appears under their "My Tickets".
      const tokenPhone = (req as any).ticketsUser?.userPhone as string | undefined;
      if (!tokenPhone) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
      }

      // Single source of truth for the buyer purchase flow (shared with the
      // in-app proxy checkout) so process + amount charged are identical.
      const result = await TicketService.purchaseForCustomer({
        eventId,
        ticketTypeId,
        quantity,
        customerPhone: tokenPhone,
        customerName: value.customerName as string | undefined,
        keshlessCardNumber,
        keshlessPin,
      });

      return ApiResponseUtil.created(res, result, 'Tickets purchased successfully!');
    } catch (error: any) {
      console.error('Purchase tickets error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to purchase tickets');
    }
  }

  /**
   * Buyer sign-in — phone + password for EXISTING accounts.
   *
   * If the number has no account yet, registration is OTP-gated: we return
   * `{ requiresRegistration: true }` (HTTP 200) so the client routes the buyer
   * to requestBuyerRegistrationOtp -> registerBuyer rather than silently
   * creating an account for an unproven phone.
   */
  static async loginBuyer(req: Request, res: Response): Promise<any> {
    try {
      const { phone, password } = req.body;
      if (!phone || !password) {
        return ApiResponseUtil.error(res, 'Phone number and password are required', 400);
      }

      const result = await BuyerAuthService.login(phone, password);
      if (result.requiresRegistration) {
        return ApiResponseUtil.success(
          res,
          result,
          'Verify your phone number to create your account'
        );
      }
      return ApiResponseUtil.success(res, result, 'Signed in successfully');
    } catch (error: any) {
      console.error('Buyer login error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to sign in', 401);
    }
  }

  /**
   * Registration step 1: send an SMS verification code to a NEW phone number.
   * Rejects numbers that already have an account.
   */
  static async requestBuyerRegistrationOtp(req: Request, res: Response): Promise<any> {
    try {
      const { phone } = req.body;
      if (!phone || typeof phone !== 'string') {
        return ApiResponseUtil.error(res, 'Phone number is required', 400);
      }

      const result = await BuyerAuthService.requestRegistrationOtp(phone);
      return ApiResponseUtil.success(res, result, 'We sent a verification code to your phone');
    } catch (error: any) {
      console.error('Request buyer registration OTP error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to send verification code', 400);
    }
  }

  /**
   * Registration step 2: verify the code, create the account with the chosen
   * password, and issue an access token.
   */
  static async registerBuyer(req: Request, res: Response): Promise<any> {
    try {
      const { phone, code, password, name } = req.body;
      if (!phone || !code || !password) {
        return ApiResponseUtil.error(res, 'Phone number, code and password are required', 400);
      }

      const result = await BuyerAuthService.registerWithOtp(phone, code, password, name);
      return ApiResponseUtil.success(res, result, 'Account created — you are signed in');
    } catch (error: any) {
      console.error('Register buyer error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to create account', 401);
    }
  }

  /**
   * Returns the payment methods available to the buyer checkout.
   * A method is included iff its config toggle is ON and (for MoMo) the
   * MTN_MOMO_ENABLED env var is 'true' (processor-configured guard for Task 6).
   * Cash is excluded — not a buyer-online method.
   */
  static async getPaymentMethods(_req: Request, res: Response): Promise<any> {
    try {
      const cfg = await PaymentConfigService.get();
      const methods: string[] = [];
      if (cfg.keshlessWalletEnabled) methods.push('keshless_wallet');
      if (cfg.mtnMomoEnabled && process.env['MTN_MOMO_ENABLED'] === 'true') methods.push('mtn_momo');
      return ApiResponseUtil.success(res, { methods });
    } catch (error: any) {
      console.error('Get public payment methods error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch payment methods');
    }
  }

  /**
   * Initiate an async MTN MoMo purchase.
   * Phone comes from the buyer token (req.ticketsUser.userPhone), NEVER the body.
   * momoPhone (the MoMo wallet number) IS from body.
   */
  static async initiateMomoPurchase(req: Request, res: Response): Promise<any> {
    const { error, value } = momoInitiateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const customerPhone = (req as any).ticketsUser?.userPhone as string | undefined;
    if (!customerPhone) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
    try {
      const r = await TicketService.initiateMomoPurchase({ ...value, customerPhone, channel: SalesChannel.ONLINE });
      return ApiResponseUtil.success(res, r);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Could not start MoMo payment', 400);
    }
  }

  /**
   * Poll MTN MoMo payment status and trigger finalization on SUCCESSFUL.
   * Ownership check: the authenticated buyer's phone must match the sale's
   * customerPhone (both normalized) — prevents IDOR on the referenceId namespace.
   * A mismatched or missing sale returns 404 to avoid leaking existence info.
   */
  static async getMomoStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyerPhone = (req as any).ticketsUser?.userPhone as string | undefined;
      if (!buyerPhone) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const referenceId = req.params['referenceId']!;
      const sale = await TicketService.getMomoSaleByReference(referenceId);

      // Normalize both phones with the same util used at purchase time.
      // If sale is missing, or phones don't match → 404 (don't reveal existence).
      if (!sale || normalizePhone(sale.customerPhone || '') !== normalizePhone(buyerPhone)) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }

      const result = await TicketService.finalizeMomoSale(referenceId);
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * List the signed-in buyer's tickets. authenticateBuyer has already put the
   * verified phone on req.ticketsUser.userPhone; we reuse the same phone-keyed
   * lookup the Keshless user-app proxy uses, with matching normalisation.
   */
  static async getMyTickets(req: Request, res: Response): Promise<any> {
    try {
      const phone = (req as any).ticketsUser?.userPhone as string | undefined;
      if (!phone) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to view your tickets');
      }

      const tickets = await TicketService.findTicketsByCustomerPhone(normalizePhone(phone));
      return ApiResponseUtil.success(res, tickets);
    } catch (error: any) {
      console.error('Get buyer tickets error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch tickets');
    }
  }
}
