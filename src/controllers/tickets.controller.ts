import { Request, Response } from 'express';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { TicketsAuthService } from '@services/ticketsAuth.service';
import { EventService } from '@services/event.service';
import { TicketService } from '@services/ticket.service';
import { ScanService } from '@services/scan.service';
import { AnalyticsService } from '@services/analytics.service';
import { ExportService } from '@services/export.service';
import { EventStatus } from '@interfaces/event.interface';
import {
  loginSchema,
  registerSchema,
  updateProfileSchema,
  changePasswordSchema,
  createEventSchema,
  updateEventSchema,
  eventQuerySchema,
  sellTicketSchema,
  refundTicketSchema,
  ticketSalesQuerySchema,
  validateTicketSchema,
  checkInTicketSchema,
  scanQuerySchema,
  analyticsQuerySchema
} from '@validators/tickets.validator';

export class TicketsController {
  /**
   * Authentication: Login
   */
  static async login(req: Request, res: Response): Promise<any> {
    try {
      // Validate input
      const { error, value } = loginSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const { identifier, password } = value;

      // Login
      const result = await TicketsAuthService.login(identifier, password);

      ApiResponseUtil.success(res, result, 'Login successful');
    } catch (error: any) {
      console.error('Login error:', error);
      ApiResponseUtil.error(res, error.message || 'Login failed', 401);
    }
  }

  /**
   * Authentication: Self-service organizer signup
   */
  static async register(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = registerSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await TicketsAuthService.register(value);

      ApiResponseUtil.created(res, result, 'Account created. You can start building events now — publishing unlocks once your account is verified.');
    } catch (error: any) {
      console.error('Register error:', error);
      ApiResponseUtil.error(res, error.message || 'Registration failed', 400);
    }
  }

  /**
   * Authentication: Refresh token
   */
  static async refresh(req: Request, res: Response): Promise<any> {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        ApiResponseUtil.error(res, 'Refresh token is required', 400);
        return;
      }

      const result = await TicketsAuthService.refreshAccessToken(refreshToken);

      ApiResponseUtil.success(res, result, 'Token refreshed successfully');
    } catch (error: any) {
      console.error('Refresh token error:', error);
      ApiResponseUtil.error(res, error.message || 'Token refresh failed', 401);
    }
  }

  /**
   * Authentication: Logout
   */
  static async logout(req: Request, res: Response): Promise<any> {
    try {
      const { refreshToken } = req.body;

      if (refreshToken) {
        await TicketsAuthService.revokeRefreshToken(refreshToken);
      }

      ApiResponseUtil.success(res, null, 'Logged out successfully');
    } catch (error: any) {
      console.error('Logout error:', error);
      ApiResponseUtil.error(res, error.message || 'Logout failed');
    }
  }

  /**
   * Authentication: Get current user
   */
  static async getMe(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      const user = await TicketsAuthService.getMe(
        ticketsUser.userId as string | undefined,
        ticketsUser.vendorId as string | undefined,
        ticketsUser.userType as string
      );

      ApiResponseUtil.success(res, user);
    } catch (error: any) {
      console.error('Get me error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch user');
    }
  }

  /**
   * User: List the authenticated Keshless user's purchased tickets.
   * Matches on the user's phone number (which the main keshless-api
   * proxy forwards as `x-user-phone` and the serviceAuth middleware
   * attaches as `req.ticketsUser.userPhone`). Falls back to the raw
   * header for direct-call scenarios (curl tests, future SDKs).
   */
  static async getMyTickets(req: Request, res: Response): Promise<any> {
    try {
      // Trust ONLY the phone the service-auth middleware attached from the
      // validated proxy request. Never read the raw x-user-phone header here —
      // that would let any holder of the service key scope the lookup to an
      // arbitrary number (spoofable-field auth bypass).
      const ticketsUser = (req as any).ticketsUser;
      const phone = ticketsUser?.userPhone as string | undefined;

      if (!phone) {
        ApiResponseUtil.unauthorized(res, 'Authenticated user phone required');
        return;
      }

      const tickets = await TicketService.findTicketsByCustomerPhone(phone);
      console.log(`[my-tickets] phone=${phone.replace(/(\+\d{3})\d+(\d{4})/, '$1***$2')} found=${tickets.length}`);
      ApiResponseUtil.success(res, tickets);
    } catch (error: any) {
      console.error('Get my tickets error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch tickets');
    }
  }

  /**
   * In-app ticket purchase for a logged-in Keshless user.
   *
   * Reached via the main keshless-api proxy (/tickets/purchase), authenticated
   * by the shared service key (dualAuth). The buyer phone is taken from the
   * proxy-forwarded x-user-phone — never the body — so the ticket binds to the
   * user's own number and shows under their My Tickets. Pays with the user's
   * Keshless card + PIN, exactly like the web buyer checkout (same shared
   * TicketService.purchaseForCustomer, same price x quantity, no add-on fee).
   */
  static async purchaseAsUser(req: Request, res: Response): Promise<any> {
    try {
      const schema = Joi.object({
        eventId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
        ticketTypeId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
        quantity: Joi.number().integer().min(1).max(10).required(),
        customerName: Joi.string().optional().max(100).trim().allow(''),
        keshlessCardNumber: Joi.string().required().length(8).alphanum().uppercase(),
        keshlessPin: Joi.string().optional().length(4).pattern(/^\d{4}$/),
      });

      const { error, value } = schema.validate(req.body);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      // Trust ONLY the phone attached by the service-auth middleware from the
      // validated proxy request — never the raw x-user-phone header (a holder
      // of the service key could otherwise bind tickets to any number).
      const ticketsUser = (req as any).ticketsUser;
      const phone = ticketsUser?.userPhone as string | undefined;
      if (!phone) {
        return ApiResponseUtil.unauthorized(res, 'Authenticated user phone required');
      }

      const result = await TicketService.purchaseForCustomer({
        eventId: value.eventId,
        ticketTypeId: value.ticketTypeId,
        quantity: value.quantity,
        customerPhone: phone,
        customerName: value.customerName,
        keshlessCardNumber: value.keshlessCardNumber,
        keshlessPin: value.keshlessPin,
      });

      return ApiResponseUtil.created(res, result, 'Tickets purchased successfully!');
    } catch (error: any) {
      console.error('Purchase (in-app) error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to purchase tickets');
    }
  }

  /**
   * User: Update profile
   */
  static async updateProfile(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = updateProfileSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const updatedUser = await TicketsAuthService.updateProfile(
        ticketsUser.userId as string | undefined,
        ticketsUser.vendorId as string | undefined,
        ticketsUser.userType as string,
        value
      );

      ApiResponseUtil.success(res, updatedUser, 'Profile updated successfully');
    } catch (error: any) {
      console.error('Update profile error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to update profile');
    }
  }

  /**
   * User: Change password
   */
  static async changePassword(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = changePasswordSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const { currentPassword, newPassword } = value;

      await TicketsAuthService.changePassword(
        ticketsUser.userId as string | undefined,
        ticketsUser.vendorId as string | undefined,
        ticketsUser.userType as string,
        currentPassword,
        newPassword
      );

      ApiResponseUtil.success(res, null, 'Password changed successfully');
    } catch (error: any) {
      console.error('Change password error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to change password');
    }
  }

  /**
   * Events: Get all events
   */
  static async getEvents(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = eventQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await EventService.getEvents({
        vendorId: ticketsUser.vendorId as string,
        ...value,
        isSuperAdmin: ticketsUser.isSuperAdmin || false
      });

      ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get events error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch events');
    }
  }

  /**
   * Events: Get single event
   */
  static async getEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const event = await EventService.getEventById(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event);
    } catch (error: any) {
      console.error('Get event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch event', 404);
    }
  }

  /**
   * Events: Get the event's creator (organiser) + their event history.
   * Powers the admin "Creator" panel.
   */
  static async getEventCreator(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const summary = await EventService.getEventCreatorSummary(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, summary);
    } catch (error: any) {
      console.error('Get event creator error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch event creator', 404);
    }
  }

  /**
   * Events: Create event
   */
  static async createEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = createEventSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const event = await EventService.createEvent({
        vendorId: ticketsUser.vendorId as string,
        ...value
      });

      ApiResponseUtil.created(res, event, 'Event created successfully');
    } catch (error: any) {
      console.error('Create event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to create event');
    }
  }

  /**
   * Events: Update event
   */
  static async updateEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      // Validate input
      const { error, value } = updateEventSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const event = await EventService.updateEvent(
        eventId as string,
        ticketsUser.vendorId as string,
        value,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Event updated successfully');
    } catch (error: any) {
      console.error('Update event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to update event');
    }
  }

  /**
   * Events: Delete event
   */
  static async deleteEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      await EventService.deleteEvent(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, null, 'Event deleted successfully');
    } catch (error: any) {
      console.error('Delete event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to delete event');
    }
  }

  /**
   * Events: Publish event
   */
  static async publishEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const event = await EventService.publishEvent(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      // Message reflects where the event actually landed: a superadmin publish
      // goes live; an organizer publish is submitted for approval.
      const message = event.status === EventStatus.PENDING_APPROVAL
        ? 'Event submitted for approval'
        : 'Event published successfully';

      ApiResponseUtil.success(res, event, message);
    } catch (error: any) {
      console.error('Publish event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to publish event');
    }
  }

  /**
   * Events: Unpublish event
   */
  static async unpublishEvent(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const event = await EventService.unpublishEvent(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Event unpublished successfully');
    } catch (error: any) {
      console.error('Unpublish event error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to unpublish event');
    }
  }

  /**
   * Ticket Types: Add ticket type to event
   */
  static async addTicketType(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;
      const { error, value } = Joi.object({
        name: Joi.string().required().trim().max(100),
        description: Joi.string().optional().max(500),
        price: Joi.number().required().min(0),
        quantity: Joi.number().required().min(1)
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const event = await EventService.addTicketType(
        eventId as string,
        ticketsUser.vendorId as string,
        value,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket type added successfully');
    } catch (error: any) {
      console.error('Add ticket type error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to add ticket type');
    }
  }

  /**
   * Ticket Types: Update ticket type
   */
  static async updateTicketType(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, ticketTypeName } = req.params;
      const { error, value } = Joi.object({
        name: Joi.string().optional().trim().max(100),
        description: Joi.string().optional().max(500),
        price: Joi.number().optional().min(0),
        quantity: Joi.number().optional().min(1)
      }).min(1).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const event = await EventService.updateTicketType(
        eventId as string,
        ticketsUser.vendorId as string,
        decodeURIComponent(ticketTypeName as string),
        value,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket type updated successfully');
    } catch (error: any) {
      console.error('Update ticket type error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to update ticket type');
    }
  }

  /**
   * Ticket Types: Delete ticket type
   */
  static async deleteTicketType(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, ticketTypeName } = req.params;

      const event = await EventService.deleteTicketType(
        eventId as string,
        ticketsUser.vendorId as string,
        decodeURIComponent(ticketTypeName as string),
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket type deleted successfully');
    } catch (error: any) {
      console.error('Delete ticket type error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to delete ticket type');
    }
  }

  /**
   * Ticket Types: Adjust quantity
   */
  static async adjustTicketQuantity(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, ticketTypeName } = req.params;
      const { error, value } = Joi.object({
        adjustment: Joi.number().required().not(0).messages({
          'any.required': 'Adjustment value is required',
          'any.invalid': 'Adjustment cannot be zero'
        })
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const event = await EventService.adjustTicketQuantity(
        eventId as string,
        ticketsUser.vendorId as string,
        decodeURIComponent(ticketTypeName as string),
        value.adjustment,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket quantity adjusted successfully');
    } catch (error: any) {
      console.error('Adjust ticket quantity error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to adjust ticket quantity');
    }
  }

  /**
   * Ticket Types: Mark as sold out
   */
  static async markTicketSoldOut(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, ticketTypeName } = req.params;
      const { error, value } = Joi.object({
        isSoldOut: Joi.boolean().required()
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const event = await EventService.markTicketSoldOut(
        eventId as string,
        ticketsUser.vendorId as string,
        decodeURIComponent(ticketTypeName as string),
        value.isSoldOut,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, event, 'Ticket sold-out status updated successfully');
    } catch (error: any) {
      console.error('Mark ticket sold out error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to update sold-out status');
    }
  }

  /**
   * Sales: Sell tickets
   */
  static async sellTickets(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = sellTicketSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await TicketService.sellTickets({
        vendorId: ticketsUser.vendorId as string,
        soldBy: (ticketsUser.userId || ticketsUser.vendorId) as string,
        soldByType: ticketsUser.userType === 'vendor' ? 'vendor' : 'sub-user',
        ...value
      });

      ApiResponseUtil.created(
        res,
        {
          sale: result.sale,
          tickets: result.tickets
        },
        result.paymentMessage || 'Tickets sold successfully'
      );
    } catch (error: any) {
      console.error('Sell tickets error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to sell tickets');
    }
  }

  /**
   * Sales: Get sales
   */
  static async getSales(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = ticketSalesQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await TicketService.getSales({
        vendorId: ticketsUser.vendorId as string,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        ...value
      });

      ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get sales error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch sales');
    }
  }

  /**
   * Sales: Get single sale
   */
  static async getSale(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { saleId } = req.params;

      const sale = await TicketService.getSaleById(saleId as string, ticketsUser.vendorId as string);

      ApiResponseUtil.success(res, sale);
    } catch (error: any) {
      console.error('Get sale error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch sale', 404);
    }
  }

  /**
   * Sales: Refund ticket
   */
  static async refundTicket(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { ticketId } = req.params;

      // Validate input
      const { error, value } = refundTicketSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const ticket = await TicketService.refundTicket(
        ticketId as string,
        ticketsUser.vendorId as string,
        value.reason
      );

      ApiResponseUtil.success(res, ticket, 'Ticket refunded successfully');
    } catch (error: any) {
      console.error('Refund ticket error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to refund ticket');
    }
  }

  /**
   * Scans: Validate ticket
   */
  static async validateTicket(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = validateTicketSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const scannedByType =
        ticketsUser.userType === 'vendor' ? 'vendor'
        : ticketsUser.userType === 'gate-operator' ? 'gate-operator'
        : 'sub-user';

      const result = await ScanService.validateTicket({
        ticketId: value.ticketId,
        vendorId: ticketsUser.vendorId as string,
        scannedBy: (ticketsUser.userId || ticketsUser.vendorId) as string,
        scannedByType,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        expectedEventId: value.expectedEventId,
      });

      if (result.valid) {
        ApiResponseUtil.success(res, result, result.message);
      } else {
        ApiResponseUtil.error(res, result.message, 400, result);
      }
    } catch (error: any) {
      console.error('Validate ticket error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to validate ticket');
    }
  }

  /**
   * Scans: Check-in ticket
   */
  static async checkInTicket(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate input
      const { error, value } = checkInTicketSchema.validate(req.body);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const scannedByType =
        ticketsUser.userType === 'vendor' ? 'vendor'
        : ticketsUser.userType === 'gate-operator' ? 'gate-operator'
        : 'sub-user';

      const result = await ScanService.checkInTicket({
        ticketId: value.ticketId,
        vendorId: ticketsUser.vendorId as string,
        scannedBy: (ticketsUser.userId || ticketsUser.vendorId) as string,
        scannedByType,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        notes: value.notes,
        expectedEventId: value.expectedEventId
      });

      if (result.valid) {
        ApiResponseUtil.success(res, result, result.message);
      } else {
        ApiResponseUtil.error(res, result.message, 400, result);
      }
    } catch (error: any) {
      console.error('Check-in ticket error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to check in ticket');
    }
  }

  /**
   * Scans: Get scans
   */
  static async getScans(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = scanQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const result = await ScanService.getScans({
        vendorId: ticketsUser.vendorId as string,
        isSuperAdmin: ticketsUser.isSuperAdmin || false,
        ...value
      });

      ApiResponseUtil.success(res, result);
    } catch (error: any) {
      console.error('Get scans error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch scans');
    }
  }

  /**
   * Entry Scanning: Aggregate scan statistics for the Entry Scan analytics row
   */
  static async getScanStats(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query (reuses the analytics schema: eventId/startDate/endDate)
      const { error, value } = analyticsQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const stats = await ScanService.getScanStats({
        vendorId: ticketsUser.vendorId as string,
        eventId: value.eventId,
        startDate: value.startDate,
        endDate: value.endDate
      });

      ApiResponseUtil.success(res, stats);
    } catch (error: any) {
      console.error('Get scan stats error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch scan statistics');
    }
  }

  /**
   * Analytics: Get dashboard stats
   */
  static async getDashboardStats(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = analyticsQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const stats = await AnalyticsService.getDashboardStats({
        vendorId: ticketsUser.vendorId as string,
        ...value,
        isSuperAdmin: ticketsUser.isSuperAdmin || false
      });

      ApiResponseUtil.success(res, stats);
    } catch (error: any) {
      console.error('Get dashboard stats error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch dashboard statistics');
    }
  }

  /**
   * Analytics: Get sales stats
   */
  static async getSalesStats(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = analyticsQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const stats = await AnalyticsService.getSalesStats({
        vendorId: ticketsUser.vendorId as string,
        ...value,
        isSuperAdmin: ticketsUser.isSuperAdmin || false
      });

      ApiResponseUtil.success(res, stats);
    } catch (error: any) {
      console.error('Get sales stats error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch sales statistics');
    }
  }

  /**
   * Analytics: Get revenue stats
   */
  static async getRevenueStats(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      // Validate query
      const { error, value } = analyticsQuerySchema.validate(req.query);
      if (error) {
        ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
        return;
      }

      const stats = await AnalyticsService.getRevenueStats({
        vendorId: ticketsUser.vendorId as string,
        ...value,
        isSuperAdmin: ticketsUser.isSuperAdmin || false
      });

      ApiResponseUtil.success(res, stats);
    } catch (error: any) {
      console.error('Get revenue stats error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch revenue statistics');
    }
  }

  /**
   * Analytics: Get event analytics
   */
  static async getEventAnalytics(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const analytics = await AnalyticsService.getEventAnalytics(
        eventId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false
      );

      ApiResponseUtil.success(res, analytics);
    } catch (error: any) {
      console.error('Get event analytics error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to fetch event analytics');
    }
  }

  /**
   * Export: Export sales
   */
  static async exportSales(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, startDate, endDate } = req.query;

      const csv = await ExportService.exportSalesToCSV({
        vendorId: ticketsUser.vendorId as string,
        eventId: eventId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });

      const filename = ExportService.getFilename('sales');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      console.error('Export sales error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to export sales');
    }
  }

  /**
   * Export: Export revenue
   */
  static async exportRevenue(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId, startDate, endDate } = req.query;

      const csv = await ExportService.exportRevenueToCSV({
        vendorId: ticketsUser.vendorId as string,
        eventId: eventId as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined
      });

      const filename = ExportService.getFilename('revenue');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      console.error('Export revenue error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to export revenue');
    }
  }

  /**
   * Export: Export event summary
   */
  static async exportEventSummary(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;
      const { eventId } = req.params;

      const csv = await ExportService.exportEventSummaryToCSV(
        eventId as string,
        ticketsUser.vendorId as string
      );

      const filename = ExportService.getFilename('event_summary');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      console.error('Export event summary error:', error);
      ApiResponseUtil.error(res, error.message || 'Failed to export event summary');
    }
  }
}
