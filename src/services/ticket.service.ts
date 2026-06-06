import { Ticket } from '@models/ticket.model';
import { TicketSale } from '@models/ticketSale.model';
import { Event } from '@models/event.model';
import { ITicket, ITicketSale, TicketStatus, PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { EventService } from '@services/event.service';
import { KeshlessPaymentService } from '@services/keshlessPayment.service';
import { normalizePhone } from '@utils/phone.util';
import mongoose from 'mongoose';

export interface SellTicketsParams {
  eventId: string;
  vendorId: string;
  ticketTypeId: string;
  quantity: number;
  customerName?: string;
  customerPhone?: string;
  paymentMethod: PaymentMethod;
  keshlessCardNumber?: string;
  keshlessPin?: string;
  soldBy: string;
  soldByType: 'vendor' | 'sub-user';
}

export interface GetSalesQuery {
  vendorId: string;
  eventId?: string;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
  isSuperAdmin?: boolean;
}

/**
 * Mongoose `populate('eventId', ...)` overwrites the `eventId` field with the
 * full event document. The dashboard, however, expects a string `eventId` plus
 * a separate populated `event` object. This reshapes a lean record to match —
 * surfacing the event name (so "Event: N/A" stops appearing) while keeping
 * `eventId` a usable id.
 */
function withEvent<T extends { eventId?: any }>(record: T): T & { event?: any } {
  const populated = record.eventId;
  if (populated && typeof populated === 'object' && populated._id) {
    return { ...record, event: populated, eventId: populated._id };
  }
  return record;
}

export class TicketService {
  /**
   * Helper to start a transaction session safely
   * Returns null if transactions are not supported (standalone MongoDB)
   */
  private static async startSessionSafely(): Promise<mongoose.ClientSession | null> {
    try {
      const session = await mongoose.startSession();
      session.startTransaction();
      return session;
    } catch (error: any) {
      // Check if error is due to MongoDB not being in replica set mode
      if (error.message?.includes('Transaction numbers are only allowed on a replica set') ||
          error.message?.includes('transactions are not supported')) {
        console.warn('⚠️  MongoDB transactions not supported (standalone mode). Running without transactions.');
        return null;
      }
      throw error;
    }
  }

  /**
   * Helper to execute database operation with optional session
   * Catches transaction errors and retries without session
   */
  private static async executeWithOptionalSession<T>(
    operation: (session?: mongoose.ClientSession) => Promise<T>,
    session: mongoose.ClientSession | null
  ): Promise<T> {
    try {
      return await operation(session || undefined);
    } catch (error: any) {
      // If transaction error and we have a session, retry without it
      if (session && (
        error.message?.includes('Transaction numbers are only allowed on a replica set') ||
        error.message?.includes('transactions are not supported')
      )) {
        console.warn('⚠️  MongoDB transactions not supported. Retrying without transaction.');
        await session.abortTransaction();
        session.endSession();
        return await operation(undefined);
      }
      throw error;
    }
  }

  /**
   * Sell tickets (both cash and wallet payment)
   */
  static async sellTickets(params: SellTicketsParams): Promise<{
    sale: ITicketSale;
    tickets: ITicket[];
    paymentMessage?: string;
  }> {
    const session = await this.startSessionSafely();

    try {
      const {
        eventId,
        vendorId,
        ticketTypeId,
        quantity,
        customerName,
        customerPhone,
        paymentMethod,
        keshlessCardNumber,
        keshlessPin,
        soldBy,
        soldByType
      } = params;

      // Check ticket availability
      const availabilityCheck = await EventService.checkTicketAvailability(
        eventId,
        ticketTypeId,
        quantity
      );

      if (!availabilityCheck.available) {
        throw new Error(availabilityCheck.message || 'Tickets not available');
      }

      const ticketTypeData = availabilityCheck.ticketTypeData!;
      const totalAmount = ticketTypeData.price * quantity;

      // Process payment based on method
      let paymentStatus = PaymentStatus.PENDING;
      let walletTransactionId: string | undefined;
      let paymentMessage = '';

      if (paymentMethod === PaymentMethod.CASH) {
        // Cash payment - mark as completed immediately
        paymentStatus = PaymentStatus.COMPLETED;
        paymentMessage = 'Cash payment received';
      } else if (paymentMethod === PaymentMethod.KESHLESS_WALLET) {
        // Wallet payment - process via Keshless Payment Service
        if (!keshlessCardNumber) {
          throw new Error('Card number is required for Keshless wallet payment');
        }

        // Call Keshless Payment API
        const paymentResult = await KeshlessPaymentService.acceptPayment({
          cardNumber: keshlessCardNumber,
          amount: totalAmount,
          pin: keshlessPin,
          description: `Keshless Tickets - ${ticketTypeData.name} x${quantity}`
        });

        if (paymentResult.status === 'failed') {
          throw new Error(paymentResult.message || paymentResult.error || 'Payment failed');
        }

        paymentStatus = PaymentStatus.COMPLETED;
        walletTransactionId = paymentResult.transactionId;
        paymentMessage = paymentResult.message || 'Wallet payment successful';
      }

      // Create tickets
      const tickets: ITicket[] = [];
      for (let i = 0; i < quantity; i++) {
        const ticket = new Ticket({
          eventId,
          vendorId,
          ticketType: ticketTypeData.name,
          price: ticketTypeData.price,
          customerName,
          customerPhone,
          status: TicketStatus.SOLD
        });

        // First save might fail with transaction error, catch and retry
        try {
          await ticket.save(session ? { session } : undefined);
        } catch (error: any) {
          if (error.message?.includes('Transaction numbers are only allowed on a replica set')) {
            console.warn('⚠️  MongoDB transactions not supported. Continuing without transaction.');
            if (session) {
              await session.abortTransaction();
              session.endSession();
            }
            // Retry all tickets without session
            const ticketsWithoutSession: ITicket[] = [];
            for (let j = 0; j < quantity; j++) {
              const t = new Ticket({
                eventId,
                vendorId,
                ticketType: ticketTypeData.name,
                price: ticketTypeData.price,
                customerName,
                customerPhone,
                status: TicketStatus.SOLD
              });
              await t.save();
              ticketsWithoutSession.push(t);
            }

            // Create sale without session
            const saleWithoutSession = new TicketSale({
              eventId,
              vendorId,
              ticketIds: ticketsWithoutSession.map(t => t._id),
              quantity,
              customerName,
              customerPhone,
              totalAmount,
              paymentMethod,
              paymentStatus,
              walletTransactionId,
              soldBy,
              soldByType: soldByType === 'vendor' ? 'Vendor' : 'VendorSubUser',
              soldAt: new Date()
            });
            await saleWithoutSession.save();

            // Update ticket sale IDs
            await Ticket.updateMany(
              { _id: { $in: ticketsWithoutSession.map(t => t._id) } },
              { saleId: saleWithoutSession._id }
            );

            // Update event ticket counts
            await EventService.updateTicketsSold(
              eventId,
              ticketTypeId,
              quantity,
              totalAmount
            );

            return {
              sale: saleWithoutSession,
              tickets: ticketsWithoutSession,
              paymentMessage
            };
          }
          throw error;
        }

        tickets.push(ticket);
      }

      // Create sale record
      const sale = new TicketSale({
        eventId,
        vendorId,
        ticketIds: tickets.map(t => t._id),
        quantity,
        customerName,
        customerPhone,
        totalAmount,
        paymentMethod,
        paymentStatus,
        walletTransactionId,
        soldBy,
        soldByType: soldByType === 'vendor' ? 'Vendor' : 'VendorSubUser',
        soldAt: new Date()
      });
      await sale.save(session ? { session } : undefined);

      // Update ticket sale IDs
      await Ticket.updateMany(
        { _id: { $in: tickets.map(t => t._id) } },
        { saleId: sale._id },
        session ? { session } : {}
      );

      // Update event ticket counts
      await EventService.updateTicketsSold(
        eventId,
        ticketTypeId,
        quantity,
        totalAmount
      );

      if (session) {
        await session.commitTransaction();
      }

      return {
        sale,
        tickets,
        paymentMessage
      };
    } catch (error: any) {
      if (session) {
        await session.abortTransaction();
      }
      console.error('Sell tickets error:', error);
      throw new Error(error.message || 'Failed to sell tickets');
    } finally {
      if (session) {
        session.endSession();
      }
    }
  }

  /**
   * Get sales with filters and pagination
   */
  static async getSales(query: GetSalesQuery) {
    try {
      const {
        vendorId,
        eventId,
        paymentMethod,
        paymentStatus,
        startDate,
        endDate,
        page = 1,
        limit = 20,
        isSuperAdmin = false
      } = query;

      // Build query — superadmins see sales across every vendor's events.
      const filter: any = {};
      if (!isSuperAdmin) filter.vendorId = vendorId;

      if (eventId) filter.eventId = eventId;
      if (paymentMethod) filter.paymentMethod = paymentMethod;
      if (paymentStatus) filter.paymentStatus = paymentStatus;

      if (startDate || endDate) {
        filter.soldAt = {};
        if (startDate) filter.soldAt.$gte = startDate;
        if (endDate) filter.soldAt.$lte = endDate;
      }

      // Execute query with pagination
      const skip = (page - 1) * limit;
      const [sales, total] = await Promise.all([
        TicketSale.find(filter)
          .populate('eventId', 'name venue eventDate')
          .populate('soldBy')
          .sort({ soldAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        TicketSale.countDocuments(filter)
      ]);

      return {
        // The dashboard reads `sale.event.name`; populate() puts the event doc
        // on `eventId`, so expose it as `event` and keep `eventId` a plain id.
        data: sales.map(withEvent),
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      };
    } catch (error: any) {
      console.error('Get sales error:', error);
      throw new Error(error.message || 'Failed to fetch sales');
    }
  }

  /**
   * Get single sale by ID
   */
  static async getSaleById(saleId: string, vendorId: string): Promise<ITicketSale> {
    try {
      const sale = await TicketSale.findOne({
        _id: saleId,
        vendorId
      })
        .populate('eventId', 'name venue eventDate')
        .populate('ticketIds')
        .populate('soldBy');

      if (!sale) {
        throw new Error('Sale not found');
      }

      return sale;
    } catch (error: any) {
      console.error('Get sale by ID error:', error);
      throw new Error(error.message || 'Failed to fetch sale');
    }
  }

  /**
   * Refund ticket
   */
  static async refundTicket(
    ticketId: string,
    vendorId: string,
    reason?: string
  ): Promise<ITicket> {
    const session = await this.startSessionSafely();

    try {
      // Find ticket
      const ticket = await Ticket.findOne({
        ticketId,
        vendorId
      }).session(session || null);

      if (!ticket) {
        throw new Error('Ticket not found');
      }

      // Check if ticket can be refunded
      if (ticket.status === TicketStatus.REFUNDED) {
        throw new Error('Ticket is already refunded');
      }

      if (ticket.status === TicketStatus.CHECKED_IN) {
        throw new Error('Cannot refund checked-in ticket');
      }

      if (ticket.status !== TicketStatus.SOLD) {
        throw new Error('Only sold tickets can be refunded');
      }

      // Get sale info
      const sale = await TicketSale.findById(ticket.saleId).session(session || null);
      if (!sale) {
        throw new Error('Sale record not found');
      }

      // Update ticket status
      ticket.status = TicketStatus.REFUNDED;
      await ticket.save(session ? { session } : undefined);

      // Update event stats
      const event = await Event.findById(ticket.eventId).session(session || null);
      if (event) {
        const ticketTypeObj = event.ticketTypes.find(tt => tt.name === ticket.ticketType);
        if (ticketTypeObj) {
          ticketTypeObj.sold -= 1;
          ticketTypeObj.available = ticketTypeObj.quantity - ticketTypeObj.sold;
        }
        event.totalTicketsSold -= 1;
        event.totalRevenue -= ticket.price;
        await event.save(session ? { session } : undefined);
      }

      if (session) {
        await session.commitTransaction();
      }

      return ticket;
    } catch (error: any) {
      if (session) {
        await session.abortTransaction();
      }
      console.error('Refund ticket error:', error);
      throw new Error(error.message || 'Failed to refund ticket');
    } finally {
      if (session) {
        session.endSession();
      }
    }
  }

  /**
   * Get tickets for an event
   */
  static async getEventTickets(
    eventId: string,
    vendorId: string,
    status?: TicketStatus
  ): Promise<ITicket[]> {
    try {
      const filter: any = { eventId, vendorId };
      if (status) filter.status = status;

      const tickets = await Ticket.find(filter)
        .sort({ createdAt: -1 })
        .lean();

      return tickets;
    } catch (error: any) {
      console.error('Get event tickets error:', error);
      throw new Error(error.message || 'Failed to fetch tickets');
    }
  }

  /**
   * Find every ticket whose customerPhone matches an authenticated user's
   * phone. Used by the Keshless user-app's "My Tickets" tab. Event details
   * are populated so the Flutter card can render event name/date/venue
   * without a follow-up call per ticket.
   *
   * Phone comparison is exact match on the same string we wrote during
   * purchase (see ticket creation in sellTickets, line ~160). If users
   * register their wallet phone in E.164 (+268…) and we also store the
   * purchase form's phone in E.164, this works. If formats diverge, this
   * lookup will under-match and we'll need a normalization step here.
   */
  static async findTicketsByCustomerPhone(phone: string): Promise<ITicket[]> {
    try {
      // Normalise here so every caller (buyer login, user-app proxy, curl)
      // matches the same way tickets are written at purchase.
      const normalized = normalizePhone(phone);
      const tickets = await Ticket.find({ customerPhone: normalized })
        .populate('eventId', 'name venue eventDate startTime endTime posterUrl')
        .sort({ createdAt: -1 })
        .lean();
      return tickets;
    } catch (error: any) {
      console.error('[my-tickets] find by phone error:', error);
      throw new Error(error.message || 'Failed to fetch tickets');
    }
  }

  /**
   * Get ticket by ID
   */
  static async getTicketById(ticketId: string, vendorId: string): Promise<ITicket> {
    try {
      const ticket = await Ticket.findOne({ ticketId, vendorId })
        .populate('eventId', 'name venue eventDate')
        .populate('saleId');

      if (!ticket) {
        throw new Error('Ticket not found');
      }

      return ticket;
    } catch (error: any) {
      console.error('Get ticket by ID error:', error);
      throw new Error(error.message || 'Failed to fetch ticket');
    }
  }

  /**
   * Get sales statistics
   */
  static async getSalesStats(
    vendorId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<{
    totalSales: number;
    totalRevenue: number;
    cashSales: number;
    walletSales: number;
    cashRevenue: number;
    walletRevenue: number;
    ticketsSold: number;
  }> {
    try {
      const filter: any = {
        vendorId,
        paymentStatus: PaymentStatus.COMPLETED
      };

      if (startDate || endDate) {
        filter.soldAt = {};
        if (startDate) filter.soldAt.$gte = startDate;
        if (endDate) filter.soldAt.$lte = endDate;
      }

      const sales = await TicketSale.find(filter);

      const stats = {
        totalSales: sales.length,
        totalRevenue: 0,
        cashSales: 0,
        walletSales: 0,
        cashRevenue: 0,
        walletRevenue: 0,
        ticketsSold: 0
      };

      for (const sale of sales) {
        stats.totalRevenue += sale.totalAmount;
        stats.ticketsSold += sale.quantity;

        if (sale.paymentMethod === PaymentMethod.CASH) {
          stats.cashSales += 1;
          stats.cashRevenue += sale.totalAmount;
        } else if (sale.paymentMethod === PaymentMethod.KESHLESS_WALLET) {
          stats.walletSales += 1;
          stats.walletRevenue += sale.totalAmount;
        }
      }

      return stats;
    } catch (error: any) {
      console.error('Get sales stats error:', error);
      throw new Error(error.message || 'Failed to fetch sales statistics');
    }
  }
}
