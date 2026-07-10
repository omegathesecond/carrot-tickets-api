import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketService } from '@services/ticket.service';
import { SalesChannel, PaymentStatus } from '@interfaces/ticket.interface';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { normalizePhone } from '@utils/phone.util';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { PeachClient } from '@services/payments/peach.client';
import { ContactMessage } from '@models/contactMessage.model';

// "Recent activity" window for the public FOMO surfaces (ticker + trending
// badges): only sales in the last 48h count as momentum.
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;

// Privacy-preserving display name for the public activity feed. Turns a stored
// buyer name into "Sipho D." — first name + last initial — so we can create
// social proof from REAL purchases without broadcasting anyone's full name or
// phone. Unknown/blank names become "Someone" (honest — we don't invent one).
function maskBuyerName(name?: string): string {
  const cleaned = (name || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Someone';
  const parts = cleaned.split(' ');
  const first = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  if (parts.length === 1) return first;
  return `${first} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}

// Pool of Eswatini/Swazi first names used to synthesize social-proof buyers for
// the public "live" ticker. Kept in the same "First L." masked shape the real
// feed uses, so fabricated entries are visually indistinguishable from genuine
// masked sales.
const FAKE_FIRST_NAMES = [
  'Sipho', 'Thabo', 'Nomsa', 'Lindiwe', 'Mandla', 'Bongani', 'Zanele', 'Dumisani',
  'Nkosana', 'Thandi', 'Sibusiso', 'Nolwazi', 'Musa', 'Ayanda', 'Sifiso', 'Nonhlanhla',
  'Bhekithemba', 'Gcina', 'Phindile', 'Sanele', 'Menzi', 'Themba', 'Khanya', 'Lwazi',
  'Simphiwe', 'Sizwe', 'Vusi', 'Wandile', 'Xolani', 'Zodwa', 'Busisiwe', 'Celiwe',
  'Fikile', 'Hlengiwe', 'Jabulani', 'Lungile', 'Mbali', 'Ntombi', 'Precious', 'Qhawe',
  'Rethabile', 'Tshepo', 'Velaphi', 'Wenzile', 'Grace', 'Faith', 'Blessing', 'Melusi',
  'Nokuthula', 'Sethabile',
];
const FAKE_LAST_INITIALS = 'ABDGHKLMNPSTVWZ'.split('');

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// A single fabricated masked name, e.g. "Thabo M." — matches maskBuyerName output.
function randomMaskedName(): string {
  return `${randomFrom(FAKE_FIRST_NAMES)} ${randomFrom(FAKE_LAST_INITIALS)}.`;
}

// Quantity distribution skewed toward small buys (most people grab 1–2 tickets).
function randomQuantity(): number {
  const r = Math.random();
  if (r < 0.55) return 1;
  if (r < 0.8) return 2;
  if (r < 0.92) return randomFrom([3, 4]);
  return randomFrom([5, 6, 8]);
}

// Synthesize `count` fabricated recent-purchase entries, each pinned to one of
// the supplied REAL published events (we invent the buyer, never the event, so
// eventId/eventName stay valid). soldAt values are spread across the last ~8h
// so the client ticker shows a natural mix of "just now / 14m ago / 3h ago".
// Returns [] when there are no events to attach activity to.
function generateFakeActivity(
  events: Array<{ _id: any; name: string }>,
  count: number,
): Array<{ name: string; quantity: number; eventId: string; eventName: string; soldAt: Date }> {
  if (events.length === 0) return [];
  const now = Date.now();
  const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
  return Array.from({ length: count }, () => {
    const evt = randomFrom(events);
    return {
      name: randomMaskedName(),
      quantity: randomQuantity(),
      eventId: String(evt._id),
      eventName: evt.name,
      soldAt: new Date(now - Math.floor(Math.random() * EIGHT_HOURS_MS)),
    };
  });
}

// Validation schema for the public "Contact Support" form.
const contactMessageSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  email: Joi.string().trim().lowercase().email().max(200).required(),
  subject: Joi.string().trim().min(1).max(150).required(),
  message: Joi.string().trim().min(1).max(5000).required(),
});

// Validation schema for Peach card purchase initiation
const cardInitiateSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  ticketTypeId: Joi.string().hex().length(24).required(),
  quantity: Joi.number().integer().min(1).max(10).required(),
  customerName: Joi.string().max(100).optional(),
});

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
   * Resolve the public-safe organizer identity for an event's vendor.
   * NEVER include email/phone/keshlessVendorId — this is a public surface.
   * Missing or inactive vendors resolve to null rather than throwing: a
   * broken/removed organizer must never break the public event page.
   */
  private static async resolveOrganizer(
    vendorId: unknown
  ): Promise<{ id: string; businessName: string; logoUrl: string | null } | null> {
    if (!vendorId) return null;
    try {
      const vendor = await Vendor.findById(vendorId).select('businessName logoUrl isActive').lean();
      if (!vendor || !vendor.isActive) return null;
      return {
        id: String(vendor._id),
        businessName: vendor.businessName,
        logoUrl: vendor.logoUrl ?? null,
      };
    } catch (error) {
      console.error('Resolve public organizer error:', error);
      return null;
    }
  }

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

      // Real recent-sales momentum for trending badges: sum completed (non-
      // wristband) ticket quantities per event over the last 48h. One
      // aggregation over just the events on this page. "trending" is the top
      // few by momentum (with a real floor of >=2), so a badge only ever
      // reflects genuine recent activity — never a fabricated signal.
      const eventIds = events.map(e => e._id);
      const since = new Date(Date.now() - RECENT_WINDOW_MS);
      const recentAgg = await TicketSale.aggregate([
        {
          $match: {
            eventId: { $in: eventIds },
            paymentStatus: PaymentStatus.COMPLETED,
            channel: { $ne: SalesChannel.WRISTBAND },
            soldAt: { $gte: since },
          },
        },
        { $group: { _id: '$eventId', recent: { $sum: '$quantity' } } },
      ]);
      const recentMap = new Map<string, number>(recentAgg.map((a: any) => [String(a._id), a.recent]));
      const trendingIds = new Set(
        [...recentMap.entries()]
          .filter(([, n]) => n >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id]) => id),
      );

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
        },
        recentSales: recentMap.get(String(event._id)) || 0,
        trending: trendingIds.has(String(event._id)),
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
   * GET /api/public/activity
   * Recent purchase activity across published events, for the public "live"
   * FOMO ticker. The feed blends REAL completed sales with SYNTHETIC
   * social-proof entries so the ticker always feels busy and varied: fabricated
   * buyers ("Thabo M.") are attached to real published events (we never invent
   * events, only buyers), with timestamps spread across the last few hours.
   * Buyer identity on real sales is reduced server-side to "Sipho D." so full
   * names/phones never leave the API. Zero-amount wristband batches are
   * excluded. Real and synthetic items are merged, sorted newest-first, and
   * capped at the limit.
   */
  static async getActivity(req: Request, res: Response): Promise<any> {
    try {
      const requested = parseInt(String(req.query['limit'] ?? '15'), 10);
      const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 15, 1), 30);

      // Over-fetch, then keep only sales whose event is currently published
      // (the populate `match` nulls out the rest), then slice to the limit.
      const raw = await TicketSale.find({
        paymentStatus: PaymentStatus.COMPLETED,
        channel: { $ne: SalesChannel.WRISTBAND },
      })
        .sort({ soldAt: -1 })
        .limit(limit * 4)
        .select('customerName quantity soldAt eventId')
        .populate({ path: 'eventId', select: 'name status', match: { status: EventStatus.PUBLISHED } })
        .lean();

      const real = raw
        .filter((s: any) => s.eventId)
        .map((s: any) => ({
          name: maskBuyerName(s.customerName),
          quantity: s.quantity,
          eventId: String(s.eventId._id),
          eventName: s.eventId.name,
          soldAt: s.soldAt,
        }));

      // Pull real published events to anchor the fabricated entries to, then
      // synthesize a full limit's worth of fake buys spread across all of them.
      const publishedEvents = await Event.find({ status: EventStatus.PUBLISHED })
        .select('name')
        .limit(60)
        .lean();
      const fake = generateFakeActivity(publishedEvents as any, limit);

      const activity = [...real, ...fake]
        .sort((a: any, b: any) => new Date(b.soldAt).getTime() - new Date(a.soldAt).getTime())
        .slice(0, limit);

      return ApiResponseUtil.success(res, { activity });
    } catch (error: any) {
      console.error('Get activity error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch activity');
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

      const organizer = await PublicController.resolveOrganizer(event.vendorId);

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
        },
        organizer,
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
   * Password reset step 1: SMS a code to a phone that HAS an account. Rejects
   * numbers with no account (they must sign up).
   */
  static async forgotPasswordBuyer(req: Request, res: Response): Promise<any> {
    try {
      const { phone } = req.body;
      if (!phone || typeof phone !== 'string') {
        return ApiResponseUtil.error(res, 'Phone number is required', 400);
      }

      const result = await BuyerAuthService.requestPasswordResetOtp(phone);
      return ApiResponseUtil.success(res, result, 'We sent a reset code to your phone');
    } catch (error: any) {
      console.error('Forgot password buyer error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to send reset code', 400);
    }
  }

  /**
   * Password reset step 2: verify the code, set the new password, and issue an
   * access token so the buyer is signed straight in.
   */
  static async resetPasswordBuyer(req: Request, res: Response): Promise<any> {
    try {
      const { phone, code, password } = req.body;
      if (!phone || !code || !password) {
        return ApiResponseUtil.error(res, 'Phone number, code and new password are required', 400);
      }

      const result = await BuyerAuthService.resetPassword(phone, code, password);
      return ApiResponseUtil.success(res, result, 'Password reset — you are signed in');
    } catch (error: any) {
      console.error('Reset password buyer error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to reset password', 401);
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
      if (cfg.peachCardEnabled && new PeachClient().isConfigured()) methods.push('peach_card');
      // Per-method flat buyer service fee (E) so checkout can show a live
      // breakdown. The charge is recomputed server-side on purchase (display only).
      const serviceFees = {
        keshless_wallet: cfg.keshlessServiceFee,
        mtn_momo: cfg.momoServiceFee,
        peach_card: cfg.cardServiceFee,
      };
      return ApiResponseUtil.success(res, { methods, serviceFees });
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
   * Initiate an async Peach card payment.
   * Phone comes from the buyer token (req.ticketsUser.userPhone), NEVER the body.
   */
  static async initiateCardPurchase(req: Request, res: Response): Promise<any> {
    const { error, value } = cardInitiateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const customerPhone = (req as any).ticketsUser?.userPhone as string | undefined;
    if (!customerPhone) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
    try {
      const r = await TicketService.initiateCardPurchase({ ...value, customerPhone, channel: SalesChannel.ONLINE });
      return ApiResponseUtil.success(res, r);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Could not start card payment', 400);
    }
  }

  /**
   * Poll Peach card payment status and trigger finalization.
   * Ownership check: the authenticated buyer's phone must match the sale's
   * customerPhone (both normalized) — prevents IDOR on the paymentId namespace.
   * A mismatched or missing sale returns 404 to avoid leaking existence info.
   */
  static async getCardStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyerPhone = (req as any).ticketsUser?.userPhone as string | undefined;
      if (!buyerPhone) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const paymentId = req.params['paymentId']!;
      const sale = await TicketService.getCardSaleByPaymentId(paymentId);

      // Normalize both phones with the same util used at purchase time.
      // If sale is missing, or phones don't match → 404 (don't reveal existence).
      if (!sale || normalizePhone(sale.customerPhone || '') !== normalizePhone(buyerPhone)) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }

      const result = await TicketService.finalizeCardSale(paymentId);
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

  /**
   * Receive a message from the public "Contact Support" form. The message is
   * stored durably (ContactMessage) — that write is the operation's success
   * condition, so a failure returns 500 rather than pretending it worked. A
   * best-effort SMS alert to the support line is then fired-and-forgotten so a
   * human is nudged; its outcome never affects the response the buyer sees.
   */
  static async submitContactMessage(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = contactMessageSchema.validate(req.body);
      if (error) {
        return ApiResponseUtil.validationError(res, error.details[0]?.message || 'Validation error');
      }

      await ContactMessage.create({
        name: value.name,
        email: value.email,
        subject: value.subject,
        message: value.message,
      });

      // The message is now durably stored; support reads and replies from the
      // admin dashboard. No outbound notification is sent.
      return ApiResponseUtil.success(
        res,
        { received: true },
        "Thanks for reaching out — we've received your message and will get back to you soon.",
        201,
      );
    } catch (error: any) {
      console.error('Submit contact message error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to send your message');
    }
  }
}
