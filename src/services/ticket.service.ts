import { Ticket } from '@models/ticket.model';
import { TicketSale } from '@models/ticketSale.model';
import { Event } from '@models/event.model';
import { ITicket, ITicketSale, TicketStatus, PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import { EventStatus } from '@interfaces/event.interface';
import { EventService } from '@services/event.service';
import { getProcessor } from '@services/payments';
import { SmsService } from '@services/sms.service';
import { normalizePhone } from '@utils/phone.util';
import { MtnMomoClient } from '@services/payments/mtnMomo.client';
import { PeachClient, classifyResultCode } from '@services/payments/peach.client';
import { ReservationService } from '@services/reservation.service';
import { TicketReservation } from '@models/ticketReservation.model';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { computeServiceFee, round2 } from '@utils/serviceFee.util';
import { computeSaleEconomics, SaleEconomics, SaleSoldByType } from '@services/saleEconomics.service';
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
  soldByType: 'vendor' | 'sub-user' | 'reseller-operator';
  // Reseller flow (Task 8 supplies these); vendor sales leave them unset.
  resellerId?: string;
  hubId?: string;
  resellerCommissionPercent?: number;
  // "Where bought". Defaults via deriveChannel(); the online buyer flow passes
  // SalesChannel.ONLINE explicitly since soldByType alone can't distinguish it.
  channel?: SalesChannel;
  // Buyer-paid FLAT service fee (online checkout only). When set, the wallet is
  // debited totalAmount + serviceFeeAmount, and the fee is recorded on the sale.
  // POS/reseller callers omit it, so face value is charged unchanged.
  serviceFeeAmount?: number;
}

/**
 * Maps the params `soldByType` union onto the persisted refPath enum value used
 * by the TicketSale `soldBy` polymorphic ref. Single source of truth so the
 * three sale-build sites can never drift.
 */
const SOLD_BY_TYPE_MAP: Record<SellTicketsParams['soldByType'], SaleSoldByType> = {
  vendor: 'Vendor',
  'sub-user': 'VendorSubUser',
  'reseller-operator': 'ResellerOperator',
};

/**
 * Derives the default sales channel from the persisted soldByType. Reseller
 * operator sales are reseller_pos; everything else defaults to box_office.
 * The online buyer flows override this by passing channel explicitly.
 */
export function deriveChannel(mappedSoldByType: SaleSoldByType): SalesChannel {
  return mappedSoldByType === 'ResellerOperator'
    ? SalesChannel.RESELLER_POS
    : SalesChannel.BOX_OFFICE;
}

export interface GetSalesQuery {
  vendorId: string;
  eventId?: string;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  channel?: SalesChannel;
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
   * Single canonical factory for building a Ticket document.
   * All three minting sites (sellTickets main loop, sellTickets no-tx fallback,
   * finalizeMomoSale) call this so field lists can never drift between paths.
   * saleId is omitted when not supplied — sellTickets sets it later via updateMany.
   */
  private static buildTicket(p: {
    eventId: any;
    vendorId: any;
    ticketType: string;
    price: number;
    customerName?: string;
    customerPhone?: string;
    saleId?: any;
  }) {
    return new Ticket({
      eventId: p.eventId,
      vendorId: p.vendorId,
      ticketType: p.ticketType,
      price: p.price,
      customerName: p.customerName,
      // Store the phone in the SAME normalized form findTicketsByCustomerPhone
      // looks tickets up by — otherwise a POS sale typed as "78422613" never
      // matches a "My Tickets" login that normalizes to "+26878422613".
      customerPhone: p.customerPhone ? normalizePhone(p.customerPhone) : p.customerPhone,
      status: TicketStatus.SOLD,
      ...(p.saleId ? { saleId: p.saleId } : {}),
    });
  }

  /**
   * Single canonical builder for the immutable economic snapshot persisted on
   * EVERY TicketSale. Resolves the live platformFeePercent from PaymentConfig,
   * runs computeSaleEconomics (which owns all money rounding), and returns the
   * snapshot fields to spread onto `new TicketSale({...})`. All sale-build sites
   * (vendor main, vendor no-tx fallback, buyer/MoMo) call this so the ledger can
   * never see a snapshot-less sale.
   */
  private static async buildSaleSnapshot(p: {
    totalAmount: number;
    paymentMethod: PaymentMethod;
    mappedSoldByType: SaleSoldByType;
    resellerCommissionPercent?: number;
  }): Promise<SaleEconomics> {
    const cfg = await PaymentConfigService.get();
    return computeSaleEconomics({
      faceAmount: p.totalAmount,
      paymentMethod: p.paymentMethod,
      soldByType: p.mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent ?? 0,
      platformFeePercent: cfg.platformFeePercent,
    });
  }

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
        paymentMethod,
        keshlessCardNumber,
        keshlessPin,
        soldBy,
        soldByType
      } = params;

      // Normalize once so the sale record + confirmation SMS use the same
      // canonical phone form the tickets are stored under (mirrors
      // purchaseForCustomer). Prevents POS "78422613" vs login "+26878422613".
      const customerPhone = params.customerPhone
        ? normalizePhone(params.customerPhone)
        : params.customerPhone;

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

      // Buyer-paid service fee (online only — callers that omit it charge face).
      // totalAmount stays face value; the wallet is debited amountCharged.
      const serviceFeeAmount = round2(params.serviceFeeAmount ?? 0);
      const amountCharged = round2(totalAmount + serviceFeeAmount);
      const feeSnapshot = { serviceFeeAmount, amountCharged };

      // Process payment based on method
      const proc = getProcessor(paymentMethod);
      const charge = await proc.charge({
        method: paymentMethod,
        amount: amountCharged,
        description: `Carrot Tickets - ${ticketTypeData.name} x${quantity}`,
        keshlessCardNumber,
        keshlessPin,
      });
      if (charge.status === 'failed') {
        throw new Error(charge.message);
      }
      // Explicit status mapping — NEVER let a non-completed charge fall through
      // to COMPLETED. A 'pending' charge (uncollected money) must persist as a
      // PENDING sale so the organizer-payout/reseller ledgers (which count only
      // `completed`) cannot credit the organizer for money not yet collected.
      // Mirrors initiateMomoPurchase's PENDING semantics: no funds confirmed yet.
      let paymentStatus: PaymentStatus;
      if (charge.status === 'completed') {
        paymentStatus = PaymentStatus.COMPLETED;
      } else if (charge.status === 'pending') {
        paymentStatus = PaymentStatus.PENDING;
      } else {
        // Defensive: any unexpected status is treated as a failure, never completed.
        throw new Error(charge.message || `Unexpected charge status: ${charge.status}`);
      }
      let walletTransactionId = charge.providerRef;
      let paymentMessage = charge.message;

      // Immutable economic snapshot — computed once, persisted on the sale in
      // BOTH the main and no-transaction-fallback branches. Without it the sale
      // would be invisible to the organizer-payout + reseller ledgers.
      const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
      const channel = params.channel ?? deriveChannel(mappedSoldByType);
      const econ = await this.buildSaleSnapshot({
        totalAmount,
        paymentMethod,
        mappedSoldByType,
        resellerCommissionPercent: params.resellerCommissionPercent,
      });
      const resellerAttribution = {
        ...(params.resellerId ? { resellerId: params.resellerId } : {}),
        ...(params.hubId ? { hubId: params.hubId } : {}),
      };

      // Create tickets
      const tickets: ITicket[] = [];
      for (let i = 0; i < quantity; i++) {
        const ticket = this.buildTicket({
          eventId,
          vendorId,
          ticketType: ticketTypeData.name,
          price: ticketTypeData.price,
          customerName,
          customerPhone,
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
              const t = this.buildTicket({
                eventId,
                vendorId,
                ticketType: ticketTypeData.name,
                price: ticketTypeData.price,
                customerName,
                customerPhone,
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
              soldByType: mappedSoldByType,
              channel,
              ...resellerAttribution,
              ...econ,
              ...feeSnapshot,
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
        soldByType: mappedSoldByType,
        channel,
        ...resellerAttribution,
        ...econ,
        ...feeSnapshot,
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
      if (session && session.inTransaction()) {
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
        channel,
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
      // Organizers only ever see paid sales — failed/pending online payment
      // attempts are platform noise reserved for Carrot super-admins, and this
      // must hold even if the client passes an explicit paymentStatus filter.
      if (isSuperAdmin) {
        if (paymentStatus) filter.paymentStatus = paymentStatus;
      } else {
        filter.paymentStatus = PaymentStatus.COMPLETED;
      }
      if (channel) filter.channel = channel;

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
          // Populate the individual tickets so the dashboard can show the
          // ticket type and the scannable ticket code(s) in sales tables.
          .populate('ticketIds', 'ticketId ticketType status')
          .populate('soldBy')
          .populate('resellerId', 'name')
          .populate('hubId', 'name')
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
   * Batch-issue zero-amount tickets for printed wristbands (dashboard
   * Wristbands tab, platform-staff-only). The tickets are REAL — same
   * TKT- code space, same scan path — but the sale is recorded on the
   * `wristband` channel with a 0 economic snapshot, so revenue reports are
   * unaffected while capacity and scan analytics stay honest.
   *
   * Deliberately no mongo session: this is a low-volume admin operation and
   * the sellTickets transaction/fallback machinery would triple the code for
   * no customer-facing benefit. Any mid-flight failure surfaces loudly and
   * the batch is simply re-run.
   */
  static async issueWristbandBatch(params: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    issuedBy?: string;
  }): Promise<{ sale: ITicketSale; tickets: ITicket[] }> {
    const { eventId, ticketTypeId, quantity } = params;

    const availabilityCheck = await EventService.checkTicketAvailability(eventId, ticketTypeId, quantity);
    if (!availabilityCheck.available) {
      throw new Error(availabilityCheck.message || 'Tickets not available');
    }
    const ticketTypeData = availabilityCheck.ticketTypeData!;

    const event = await Event.findById(eventId).select('vendorId').lean();
    if (!event) throw new Error('Event not found');
    const vendorId = (event as any).vendorId;
    const soldBy = params.issuedBy ?? vendorId;

    const econ = await this.buildSaleSnapshot({
      totalAmount: 0,
      paymentMethod: PaymentMethod.CASH,
      mappedSoldByType: 'Vendor',
    });

    const tickets: ITicket[] = [];
    for (let i = 0; i < quantity; i++) {
      const ticket = this.buildTicket({
        eventId,
        vendorId,
        ticketType: ticketTypeData.name,
        price: 0,
      });
      await ticket.save();
      tickets.push(ticket);
    }

    const sale = new TicketSale({
      eventId,
      vendorId,
      ticketIds: tickets.map((t) => t._id),
      quantity,
      totalAmount: 0,
      paymentMethod: PaymentMethod.CASH,
      paymentStatus: PaymentStatus.COMPLETED,
      soldBy,
      soldByType: 'Vendor',
      channel: SalesChannel.WRISTBAND,
      ...econ,
      serviceFeeAmount: 0,
      amountCharged: 0,
      soldAt: new Date(),
    });
    await sale.save();

    await Ticket.updateMany({ _id: { $in: tickets.map((t) => t._id) } }, { saleId: sale._id });
    await EventService.updateTicketsSold(eventId, ticketTypeId, quantity, 0);

    return { sale, tickets };
  }

  /**
   * Buy ticket(s) for an end customer paying with their Keshless wallet.
   *
   * This is the single source of truth for the buyer purchase flow: the
   * public/web buyer checkout (PublicController) and the in-app proxy
   * checkout (TicketsController.purchaseAsUser) both call it, so the process
   * and the amount charged are guaranteed identical. The buyer pays exactly
   * price x quantity — there is no separate add-on fee.
   */
  static async purchaseForCustomer(params: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    customerPhone: string;
    customerName?: string;
    keshlessCardNumber: string;
    keshlessPin?: string;
  }): Promise<{
    tickets: Array<{
      ticketId: string;
      eventName: string;
      ticketType: string;
      eventDate: Date;
      venue: string;
    }>;
    transactionId?: string;
    totalAmount: number;
    quantity: number;
    event: { name: string; date: Date; venue: string };
  }> {
    const {
      eventId,
      ticketTypeId,
      quantity,
      keshlessCardNumber,
      keshlessPin,
    } = params;

    const customerPhone = normalizePhone(params.customerPhone);
    // Name only personalises the printed ticket; fall back to the phone so a
    // ticket is never nameless.
    const customerName = params.customerName?.trim() || customerPhone;

    // Only published events are buyable.
    const event = await Event.findOne({ _id: eventId, status: EventStatus.PUBLISHED });
    if (!event) {
      throw new Error('Event not found or not available');
    }

    const ticketType = event.ticketTypes.find(tt => tt._id?.toString() === ticketTypeId);
    if (!ticketType) {
      throw new Error('Ticket type not found');
    }

    if (ticketType.isSoldOut || ticketType.available < quantity) {
      throw new Error(`Only ${ticketType.available} tickets available`);
    }

    const totalAmount = ticketType.price * quantity;

    // PIN threshold keys off the FACE subtotal (the service fee must not shift
    // the PIN rule). Buyer-paid service fee is added on top of face.
    if (totalAmount >= 50 && !keshlessPin) {
      throw new Error('PIN required for purchases of E50 or more');
    }

    const feeCfg = await PaymentConfigService.get();
    const { serviceFeeAmount } = computeServiceFee(
      totalAmount,
      PaymentMethod.KESHLESS_WALLET,
      feeCfg,
    );

    // sellTickets debits the wallet (face + service fee) and mints tickets.
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
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
      serviceFeeAmount,
    });

    // Best-effort SMS confirmation — never roll back the purchase on SMS failure.
    if (customerPhone) {
      SmsService.sendTicketConfirmation(
        customerPhone,
        result.tickets.map((t) => ({
          ticketId: t.ticketId,
          eventName: event.name,
          eventDate: event.eventDate.toISOString(),
          venue: event.venue,
        })),
      ).catch((err) => console.error('[SMS] confirmation send threw', err));
    }

    return {
      tickets: result.tickets.map(ticket => ({
        ticketId: ticket.ticketId,
        eventName: event.name,
        ticketType: ticketType.name,
        eventDate: event.eventDate,
        venue: event.venue,
      })),
      transactionId: result.sale.walletTransactionId,
      totalAmount,
      quantity,
      event: { name: event.name, date: event.eventDate, venue: event.venue },
    };
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

  // ── MTN MoMo async payment client (mocked in tests via jest.mock at module level) ──
  private static momoClient = new MtnMomoClient();
  // ── Peach card async payment client (mocked in tests via jest.mock at module level) ──
  private static peachClient = new PeachClient();
  private static MOMO_TTL_MS = 5 * 60_000; // 5 minutes
  private static CARD_TTL_MS = 15 * 60_000; // 15 min — card redirect (3DS/OTP) takes longer than MoMo

  /**
   * Initiate an async MTN MoMo purchase:
   * 1) Create PENDING sale with no tickets yet.
   * 2) Reserve inventory (prevent oversell during the async window).
   * 3) Call requestToPay on MTN — on failure, release reservation + fail sale + rethrow.
   */
  static async initiateMomoPurchase(p: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    customerPhone: string;
    customerName?: string;
    momoPhone: string;
    // Optional reseller attribution (additive — buyer/vendor callers omit these
    // and keep the existing vendor-default behavior). When provided, the PENDING
    // sale carries the SAME snapshot shape as a reseller cash sale except
    // fundsCustody derives to 'carrot' because MoMo is electronic.
    vendorId?: string;
    soldBy?: string;
    soldByType?: 'vendor' | 'reseller-operator';
    resellerId?: string;
    hubId?: string;
    resellerCommissionPercent?: number;
    channel?: SalesChannel;
  }): Promise<{ referenceId: string; saleId: string; expiresAt: Date }> {
    if (!this.momoClient.isConfigured()) throw new Error('MTN MoMo is not available');

    const avail = await EventService.checkTicketAvailability(p.eventId, p.ticketTypeId, p.quantity);
    if (!avail.available) throw new Error(avail.message || 'Tickets not available');

    const tt = avail.ticketTypeData!;
    const totalAmount = tt.price * p.quantity;

    const event = await Event.findById(p.eventId);
    if (!event) throw new Error('Event not found');

    // Attribution: vendorId is the event organizer (derive from event if absent,
    // as the buyer/vendor path does today). soldBy defaults to the organizer.
    const soldByType = p.soldByType ?? 'vendor';
    const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
    const channel = p.channel ?? deriveChannel(mappedSoldByType);
    const vendorId = p.vendorId ?? event.vendorId;
    const soldBy = p.soldBy ?? event.vendorId;

    // Immutable economic snapshot — an electronic (mtn_momo) sale, so custody
    // derives to 'carrot'. Computed via the SAME DRY helper used everywhere so
    // a reseller MoMo initiate yields organizerProceeds = face − commission −
    // fee with soldByType 'ResellerOperator'. Written now so the sale is
    // ledger-visible even before tickets are minted at finalize.
    const econ = await this.buildSaleSnapshot({
      totalAmount,
      paymentMethod: PaymentMethod.MTN_MOMO,
      mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent,
    });
    const resellerAttribution = {
      ...(p.resellerId ? { resellerId: p.resellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
    };

    // Buyer-paid service fee — ONLINE checkout only (reseller/POS stay at face).
    const feeCfg = await PaymentConfigService.get();
    const { serviceFeeAmount, amountCharged } =
      channel === SalesChannel.ONLINE
        ? computeServiceFee(totalAmount, PaymentMethod.MTN_MOMO, feeCfg)
        : { serviceFeeAmount: 0, amountCharged: totalAmount };

    // 1) PENDING sale, no tickets yet
    const sale = new TicketSale({
      eventId: p.eventId,
      vendorId,
      ticketIds: [],
      quantity: p.quantity,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      totalAmount,
      paymentMethod: PaymentMethod.MTN_MOMO,
      paymentStatus: PaymentStatus.PENDING,
      soldBy,
      soldByType: mappedSoldByType,
      channel,
      ...resellerAttribution,
      ...econ,
      serviceFeeAmount,
      amountCharged,
      soldAt: new Date(),
    });
    await sale.save();

    // 2) Reserve inventory
    const { expiresAt } = await ReservationService.reserve({
      eventId: p.eventId,
      ticketTypeId: p.ticketTypeId,
      quantity: p.quantity,
      saleId: sale._id.toString(),
      ttlMs: this.MOMO_TTL_MS,
    });
    sale.reservationExpiresAt = expiresAt;

    // 3) Request to pay (currency from env; sandbox uses EUR)
    try {
      // MTN keys its directory on the FULL international MSISDN with no '+'
      // (e.g. 26876707421). A bare local number like 76707421 returns
      // PAYER_NOT_FOUND, so normalise to +268… then strip the leading '+'.
      const payerMsisdn = normalizePhone(p.momoPhone).replace(/^\+/, '');
      const { referenceId } = await this.momoClient.requestToPay({
        amount: amountCharged,
        currency: process.env['MTN_MOMO_CURRENCY'] || 'SZL',
        payerMsisdn,
        externalId: sale.saleId,
        payerMessage: `Carrot Tickets - ${tt.name} x${p.quantity}`,
      });
      sale.momoReferenceId = referenceId;
      await sale.save();
      return { referenceId, saleId: sale._id.toString(), expiresAt };
    } catch (err) {
      // Surface failure loudly: release the hold + fail the sale (no silent fallback)
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      throw err;
    }
  }

  /**
   * Look up a MoMo sale by its MTN referenceId for ownership verification.
   * Returns null if not found. Never throws.
   */
  static async getMomoSaleByReference(referenceId: string): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ momoReferenceId: referenceId });
  }

  /**
   * Look up a MoMo sale by the externalId we sent to MTN (= sale.saleId).
   * MTN's requesttopay callback carries `externalId`, NOT our X-Reference-Id,
   * so this is how we correlate an inbound callback back to its sale.
   * Returns null if not found. Never throws.
   */
  static async getMomoSaleByExternalId(externalId: string): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ saleId: externalId });
  }

  /**
   * Initiate an async Peach card purchase:
   * 1) Create PENDING sale with no tickets yet.
   * 2) Reserve inventory (prevent oversell during the async window).
   * 3) Call createPayment on Peach — on failure, release reservation + fail sale + rethrow.
   *
   * Mirrors initiateMomoPurchase exactly; differences: no payer phone,
   * paymentMethod = PaymentMethod.PEACH_CARD, provider call is peachClient.createPayment.
   */
  static async initiateCardPurchase(p: {
    eventId: string;
    ticketTypeId: string;
    quantity: number;
    customerPhone?: string;
    customerName?: string;
    vendorId?: string;
    soldBy?: string;
    soldByType?: 'vendor' | 'reseller-operator';
    resellerId?: string;
    hubId?: string;
    resellerCommissionPercent?: number;
    channel?: SalesChannel;
  }): Promise<{ paymentId: string; redirect: any; saleId: string; expiresAt: Date }> {
    if (!this.peachClient.isConfigured()) throw new Error('Card payments are not available');

    const cardCfg = await PaymentConfigService.get();
    if (!cardCfg.peachCardEnabled) throw new Error('Card payments are not available');

    const avail = await EventService.checkTicketAvailability(p.eventId, p.ticketTypeId, p.quantity);
    if (!avail.available) throw new Error(avail.message || 'Tickets not available');

    const tt = avail.ticketTypeData!;
    const totalAmount = tt.price * p.quantity;

    const event = await Event.findById(p.eventId);
    if (!event) throw new Error('Event not found');

    // Attribution: mirror initiateMomoPurchase defaults exactly.
    const soldByType = p.soldByType ?? 'vendor';
    const mappedSoldByType = SOLD_BY_TYPE_MAP[soldByType];
    const channel = p.channel ?? deriveChannel(mappedSoldByType);
    const vendorId = p.vendorId ?? event.vendorId;
    const soldBy = p.soldBy ?? event.vendorId;

    // Immutable economic snapshot — card is electronic so custody derives to 'carrot'.
    const econ = await this.buildSaleSnapshot({
      totalAmount,
      paymentMethod: PaymentMethod.PEACH_CARD,
      mappedSoldByType,
      resellerCommissionPercent: p.resellerCommissionPercent,
    });
    const resellerAttribution = {
      ...(p.resellerId ? { resellerId: p.resellerId } : {}),
      ...(p.hubId ? { hubId: p.hubId } : {}),
    };

    // Buyer-paid service fee — ONLINE checkout only (reseller/POS stay at face).
    const { serviceFeeAmount, amountCharged } =
      channel === SalesChannel.ONLINE
        ? computeServiceFee(totalAmount, PaymentMethod.PEACH_CARD, cardCfg)
        : { serviceFeeAmount: 0, amountCharged: totalAmount };

    // 1) PENDING sale, no tickets yet
    const sale = new TicketSale({
      eventId: p.eventId,
      vendorId,
      ticketIds: [],
      quantity: p.quantity,
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      totalAmount,
      paymentMethod: PaymentMethod.PEACH_CARD,
      paymentStatus: PaymentStatus.PENDING,
      soldBy,
      soldByType: mappedSoldByType,
      channel,
      ...resellerAttribution,
      ...econ,
      serviceFeeAmount,
      amountCharged,
      soldAt: new Date(),
    });
    await sale.save();

    // 2) Reserve inventory
    const { expiresAt } = await ReservationService.reserve({
      eventId: p.eventId,
      ticketTypeId: p.ticketTypeId,
      quantity: p.quantity,
      saleId: sale._id.toString(),
      ttlMs: this.CARD_TTL_MS,
    });
    sale.reservationExpiresAt = expiresAt;

    // 3) Create Peach payment; on failure release + fail + rethrow (no silent fallback)
    if (!process.env['CARD_RESULT_URL']) throw new Error('CARD_RESULT_URL is not configured');
    try {
      const nonce = sale.saleId + '-' + sale._id.toString();
      const { id, redirect } = await this.peachClient.createPayment({
        amount: amountCharged,
        currency: process.env['CARD_CURRENCY'] || 'ZAR',
        merchantTransactionId: sale.saleId,
        shopperResultUrl: process.env['CARD_RESULT_URL']!,
        nonce,
      });
      sale.peachPaymentId = id;
      await sale.save();
      return { paymentId: id, redirect, saleId: sale._id.toString(), expiresAt };
    } catch (err) {
      // Surface failure loudly: release the hold + fail the sale (no silent fallback)
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      throw err;
    }
  }

  /**
   * Look up a card sale by its Peach payment ID.
   * Returns null if not found. Never throws.
   */
  static async getCardSaleByPaymentId(id: string): Promise<InstanceType<typeof TicketSale> | null> {
    return TicketSale.findOne({ peachPaymentId: id });
  }

  /**
   * Finalize an MTN MoMo sale identified by referenceId. Idempotent.
   * - If sale is not PENDING → return current status immediately.
   * - Query MTN status; PENDING → return pending; FAILED → release + fail.
   * - SUCCESSFUL → ATOMIC claim via findOneAndUpdate({_id, paymentStatus:PENDING})
   *   to prevent double-mint from concurrent poll + callback. Then mint tickets,
   *   confirm reservation (reserved→sold), update event sold count, best-effort SMS.
   */
  static async finalizeMomoSale(referenceId: string): Promise<{ status: 'completed' | 'failed' | 'pending'; reason?: string }> {
    const sale = await TicketSale.findOne({ momoReferenceId: referenceId });
    if (!sale) {
      console.error('[momo finalize] ✗ no sale for reference', { referenceId });
      throw new Error('Sale not found for reference');
    }
    console.log('[momo finalize] → sale found', {
      referenceId,
      saleId: sale._id.toString(),
      paymentStatus: sale.paymentStatus,
      totalAmount: sale.totalAmount,
      quantity: sale.quantity,
      customerPhone: sale.customerPhone,
      eventId: sale.eventId?.toString(),
    });

    // Already finalized — idempotent return
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      console.log('[momo finalize] ↩ already finalized (idempotent)', {
        referenceId,
        paymentStatus: sale.paymentStatus,
      });
      return sale.paymentStatus === PaymentStatus.COMPLETED
        ? { status: 'completed' }
        : { status: 'failed', reason: sale.momoFailureReason };
    }

    const { status, raw } = await this.momoClient.getStatus(referenceId);
    console.log('[momo finalize] MTN status', { referenceId, status });
    if (status === 'PENDING') {
      console.log('[momo finalize] ↩ still PENDING — not minting yet', { referenceId });
      return { status: 'pending' };
    }

    const reservation = await TicketReservation.findOne({ saleId: sale._id });
    const ticketTypeId = reservation?.ticketTypeId;

    if (status === 'FAILED') {
      const reason = typeof raw?.reason === 'string' ? raw.reason : undefined;
      console.warn('[momo finalize] ✗ MTN reports FAILED — releasing reservation', {
        referenceId,
        saleId: sale._id.toString(),
        reason,
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      if (reason) sale.momoFailureReason = reason;
      await sale.save();
      return { status: 'failed', reason };
    }

    // SUCCESSFUL — but verify MTN confirms the EXACT amount + currency we requested
    // before minting anything. The payer can only ever approve our requested amount,
    // so a mismatch means a bug, a currency drift, or a tampered/stale reference:
    // fail it LOUDLY rather than silently honour a charge that doesn't match the sale.
    const expectedCurrency = process.env['MTN_MOMO_CURRENCY'] || 'SZL';
    // Verify against what we actually charged (face + service fee). Fall back to
    // totalAmount for pre-service-fee sales that have no amountCharged.
    const expectedAmount = sale.amountCharged ?? sale.totalAmount;
    const confirmedAmount = Number(raw?.amount);
    if (
      !Number.isFinite(confirmedAmount) ||
      confirmedAmount !== expectedAmount ||
      raw?.currency !== expectedCurrency
    ) {
      console.error('[momo finalize] amount/currency mismatch — refusing to mint', {
        referenceId,
        expected: { amount: expectedAmount, currency: expectedCurrency },
        confirmed: { amount: raw?.amount, currency: raw?.currency },
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      sale.momoFailureReason = 'AMOUNT_MISMATCH';
      await sale.save();
      return { status: 'failed', reason: 'AMOUNT_MISMATCH' };
    }

    // atomically CLAIM the sale so concurrent poll + callback can't double-mint
    const claimed = await TicketSale.findOneAndUpdate(
      { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED } },
      { new: true }
    );
    if (!claimed) {
      console.log('[momo finalize] ↩ claim lost — already finalized by concurrent poll/callback', {
        referenceId,
        saleId: sale._id.toString(),
      });
      return { status: 'completed' }; // someone else already finalized it
    }
    console.log('[momo finalize] ✓ claimed sale — minting tickets', {
      referenceId,
      saleId: sale._id.toString(),
      quantity: sale.quantity,
      financialTransactionId: raw?.financialTransactionId,
    });

    // Mint tickets, convert reservation (reserved→sold), SMS
    const event = await Event.findById(sale.eventId);
    const ticketTypeDoc = event?.ticketTypes.find((t: any) => t._id?.toString() === ticketTypeId);
    const tickets: ITicket[] = [];
    for (let i = 0; i < sale.quantity; i++) {
      const t = this.buildTicket({
        eventId: sale.eventId,
        vendorId: sale.vendorId,
        ticketType: ticketTypeDoc?.name || 'Ticket',
        price: sale.totalAmount / sale.quantity,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        saleId: sale._id,
      });
      await t.save();
      tickets.push(t);
    }

    claimed.ticketIds = tickets.map(t => t._id as mongoose.Types.ObjectId);
    await claimed.save();

    await ReservationService.confirm(sale._id.toString()); // reserved -= qty
    if (ticketTypeId) {
      await EventService.updateTicketsSold(
        sale.eventId.toString(),
        ticketTypeId,
        sale.quantity,
        sale.totalAmount
      ); // sold += qty
    }

    if (sale.customerPhone && event) {
      SmsService.sendTicketConfirmation(
        sale.customerPhone,
        tickets.map(t => ({
          ticketId: t.ticketId,
          eventName: event.name,
          eventDate: event.eventDate.toISOString(),
          venue: event.venue,
        }))
      ).catch(err => console.error('[SMS] momo confirmation threw', err));
    }

    console.log('[momo finalize] ✓ completed — tickets minted', {
      referenceId,
      saleId: sale._id.toString(),
      ticketCount: tickets.length,
      ticketIds: tickets.map(t => t.ticketId),
    });
    return { status: 'completed' };
  }

  /**
   * Finalize a Peach card sale identified by paymentId. Idempotent.
   * - If sale is not PENDING → return current status immediately (no re-mint).
   * - Query Peach status; pending code → return pending; rejected → release + fail.
   * - Success → AMOUNT/CURRENCY GUARD: Number(amount) must equal sale.totalAmount
   *   and currency must match CARD_CURRENCY env (default ZAR). Mismatch → release + fail.
   * - ATOMIC claim via findOneAndUpdate({_id, paymentStatus:PENDING}) to prevent
   *   double-mint from concurrent poll + webhook. Then mint tickets, confirm
   *   reservation (reserved→sold), update event sold count, best-effort SMS.
   *
   * Mirrors finalizeMomoSale exactly; differences: lookup by peachPaymentId,
   * status via peachClient.getPaymentStatus, amount guard uses CARD_CURRENCY.
   */
  static async finalizeCardSale(paymentId: string): Promise<{ status: 'completed' | 'failed' | 'pending' }> {
    const sale = await TicketSale.findOne({ peachPaymentId: paymentId });
    if (!sale) throw new Error('Sale not found for payment id');

    // Already finalized — idempotent return
    if (sale.paymentStatus !== PaymentStatus.PENDING) {
      return { status: sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed' : 'failed' };
    }

    const { code, amount, currency } = await this.peachClient.getPaymentStatus(paymentId);
    const outcome = classifyResultCode(code || '');

    if (outcome === 'pending') return { status: 'pending' };

    const reservation = await TicketReservation.findOne({ saleId: sale._id });
    const ticketTypeId = reservation?.ticketTypeId;

    if (outcome === 'rejected') {
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // success — verify the EXACT amount + currency Peach reports before minting.
    // Peach returns amount as a string (e.g. "50.00"); convert to Number for comparison.
    const expectedCurrency = process.env['CARD_CURRENCY'] || 'ZAR';
    // Verify against what we actually charged (face + service fee). Fall back to
    // totalAmount for pre-service-fee sales that have no amountCharged.
    const expectedAmount = sale.amountCharged ?? sale.totalAmount;
    const confirmedAmount = Number(amount);
    if (
      !Number.isFinite(confirmedAmount) ||
      confirmedAmount !== expectedAmount ||
      currency !== expectedCurrency
    ) {
      console.error('[card finalize] amount/currency mismatch — refusing to mint', {
        paymentId,
        expected: { amount: expectedAmount, currency: expectedCurrency },
        confirmed: { amount, currency },
      });
      await ReservationService.release(sale._id.toString());
      sale.paymentStatus = PaymentStatus.FAILED;
      await sale.save();
      return { status: 'failed' };
    }

    // Atomically CLAIM the sale so concurrent poll + webhook can't double-mint
    const claimed = await TicketSale.findOneAndUpdate(
      { _id: sale._id, paymentStatus: PaymentStatus.PENDING },
      { $set: { paymentStatus: PaymentStatus.COMPLETED } },
      { new: true }
    );
    if (!claimed) return { status: 'completed' }; // someone else already finalized

    // Mint tickets, confirm reservation (reserved→sold), best-effort SMS
    const event = await Event.findById(sale.eventId);
    const ticketTypeDoc = event?.ticketTypes.find((t: any) => t._id?.toString() === ticketTypeId);
    const tickets: ITicket[] = [];
    for (let i = 0; i < sale.quantity; i++) {
      const t = this.buildTicket({
        eventId: sale.eventId,
        vendorId: sale.vendorId,
        ticketType: ticketTypeDoc?.name || 'Ticket',
        price: sale.totalAmount / sale.quantity,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        saleId: sale._id,
      });
      await t.save();
      tickets.push(t);
    }

    claimed.ticketIds = tickets.map(t => t._id as mongoose.Types.ObjectId);
    await claimed.save();

    await ReservationService.confirm(sale._id.toString()); // reserved -= qty
    if (ticketTypeId) {
      await EventService.updateTicketsSold(
        sale.eventId.toString(),
        ticketTypeId,
        sale.quantity,
        sale.totalAmount
      ); // sold += qty
    }

    if (sale.customerPhone && event) {
      SmsService.sendTicketConfirmation(
        sale.customerPhone,
        tickets.map(t => ({
          ticketId: t.ticketId,
          eventName: event.name,
          eventDate: event.eventDate.toISOString(),
          venue: event.venue,
        }))
      ).catch(err => console.error('[SMS] card confirmation threw', err));
    }

    return { status: 'completed' };
  }

  /**
   * Reconciliation backstop: finalise Peach card sales that are still PENDING
   * despite the buyer having (possibly) paid — i.e. the return endpoint, the
   * webhook AND the SPA poll all missed. Runs on an interval; asks Peach for
   * each sale's true status via finalizeCardSale (success→mint, rejected→
   * release+fail, still-pending→left untouched). finalizeCardSale is idempotent
   * and pending-safe, so re-running is harmless.
   *
   * `olderThanMs` skips brand-new sales where the buyer is still on the hosted
   * page (avoids hammering Peach); the 2-min default sits far inside the 15-min
   * CARD_TTL_MS reservation hold, so paid sales are recovered long before the
   * reservation-expiry sweep would fail them.
   */
  static async reconcilePendingCardSales(olderThanMs = 2 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = await TicketSale.find({
      paymentMethod: PaymentMethod.PEACH_CARD,
      paymentStatus: PaymentStatus.PENDING,
      peachPaymentId: { $exists: true, $nin: [null, ''] },
      createdAt: { $lt: cutoff },
    }).limit(50);

    let finalized = 0;
    for (const sale of stuck) {
      try {
        const r = await this.finalizeCardSale(sale.peachPaymentId as string);
        if (r.status !== 'pending') finalized++;
      } catch (err) {
        console.error(`[card-reconcile] failed for sale ${sale.saleId}`, err);
      }
    }
    if (finalized > 0) console.log(`[card-reconcile] finalised ${finalized}/${stuck.length} stuck card sale(s)`);
    return finalized;
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
