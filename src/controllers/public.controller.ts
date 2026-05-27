import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import { TicketService } from '@services/ticket.service';

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
  customerName: Joi.string().optional().max(100).trim(),
  customerPhone: Joi.string().optional().max(20).trim(),
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
        customerName,
        customerPhone,
        keshlessCardNumber,
        keshlessPin
      } = value;

      // Get the event
      const event = await Event.findOne({
        _id: eventId,
        status: EventStatus.PUBLISHED
      });

      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found or not available');
      }

      // Find ticket type
      const ticketType = event.ticketTypes.find(tt => tt._id?.toString() === ticketTypeId);
      if (!ticketType) {
        return ApiResponseUtil.error(res, 'Ticket type not found', 404);
      }

      // Check availability
      if (ticketType.isSoldOut || ticketType.available < quantity) {
        return ApiResponseUtil.error(
          res,
          `Only ${ticketType.available} tickets available`,
          400
        );
      }

      // Calculate total amount
      const totalAmount = ticketType.price * quantity;

      // Check if PIN is required (amount >= 50)
      if (totalAmount >= 50 && !keshlessPin) {
        return ApiResponseUtil.error(
          res,
          'PIN required for purchases of E50 or more',
          400
        );
      }

      // Delegate payment + ticket creation to TicketService.sellTickets so we
      // only debit the wallet once. (Previously the controller pre-charged via
      // KeshlessPaymentService and then sellTickets charged again internally,
      // failing on the second attempt and 500ing while the first debit had
      // already cleared.)
      const result = await TicketService.sellTickets({
        vendorId: event.vendorId.toString(),
        eventId,
        ticketTypeId,
        quantity,
        customerName,
        customerPhone,
        paymentMethod: PaymentMethod.KESHLESS_WALLET,
        keshlessCardNumber,
        keshlessPin,
        soldBy: event.vendorId.toString(),
        soldByType: 'vendor'
      });

      return ApiResponseUtil.created(
        res,
        {
          tickets: result.tickets.map(ticket => ({
            ticketId: ticket.ticketId,
            eventName: event.name,
            ticketType: ticketType.name,
            eventDate: event.eventDate,
            venue: event.venue
          })),
          transactionId: result.sale.walletTransactionId,
          totalAmount,
          quantity,
          event: {
            name: event.name,
            date: event.eventDate,
            venue: event.venue
          }
        },
        'Tickets purchased successfully!'
      );
    } catch (error: any) {
      console.error('Purchase tickets error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to purchase tickets');
    }
  }
}
