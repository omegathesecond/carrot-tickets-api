import { Reseller } from '@models/reseller.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { TicketService } from '@services/ticket.service';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

type ResellerPaymentMethod = 'cash' | 'mtn_momo' | 'keshless_wallet';

interface CreateSaleParams {
  operatorId: string;
  resellerId: string;
  hubId: string;
  eventId: string;
  ticketTypeId: string;
  quantity: number;
  paymentMethod: ResellerPaymentMethod;
  customerName?: string;
  customerPhone?: string;
  keshlessCardNumber?: string;
  keshlessPin?: string;
}

interface CreateSaleResult {
  saleId: string;
  status: 'completed' | 'pending' | 'failed';
  tickets: any[];
  message?: string;
}

// Maps the ResellerPaymentMethod to the PaymentConfig toggle key.
const METHOD_TOGGLE: Record<ResellerPaymentMethod, keyof Awaited<ReturnType<typeof PaymentConfigService.get>>> = {
  cash: 'cashEnabled',
  mtn_momo: 'mtnMomoEnabled',
  keshless_wallet: 'keshlessWalletEnabled',
};

// Maps the string method to the PaymentMethod enum used by TicketService.
const METHOD_ENUM: Record<ResellerPaymentMethod, PaymentMethod> = {
  cash: PaymentMethod.CASH,
  mtn_momo: PaymentMethod.MTN_MOMO,
  keshless_wallet: PaymentMethod.KESHLESS_WALLET,
};

export class ResellerSaleService {
  /**
   * Reseller POS sale path.
   *
   * Guards:
   * 1. Payment method must be enabled in PaymentConfig.
   * 2. Reseller must exist and not be suspended.
   * 3. Event must exist and be published (to resolve vendorId).
   *
   * All capacity, payment processing, ticket minting, and economic snapshot
   * work is delegated to TicketService.sellTickets — do NOT duplicate it here.
   */
  static async createSale(params: CreateSaleParams): Promise<CreateSaleResult> {
    const cfg = await PaymentConfigService.get();

    // Guard 1: payment method toggle
    const toggleKey = METHOD_TOGGLE[params.paymentMethod];
    if (!cfg[toggleKey]) {
      throw new Error('Payment method not available');
    }

    // Guard 2: reseller must exist and be active
    const reseller = await Reseller.findById(params.resellerId);
    if (!reseller) {
      throw new Error(`Reseller not found: ${params.resellerId}`);
    }
    if (reseller.status === 'suspended') {
      throw new Error(`Reseller is suspended: ${params.resellerId}`);
    }

    // Resolve commission: reseller-specific takes precedence over platform default.
    const resellerCommissionPercent =
      reseller.commissionPercent ?? cfg.defaultResellerCommissionPercent;

    // Guard 3: event must exist and be published (gives us vendorId)
    const event = await Event.findOne({ _id: params.eventId, status: EventStatus.PUBLISHED });
    if (!event) {
      throw new Error(`Event not found or not published: ${params.eventId}`);
    }

    const { sale, tickets, paymentMessage } = await TicketService.sellTickets({
      eventId: params.eventId,
      vendorId: event.vendorId.toString(),
      ticketTypeId: params.ticketTypeId,
      quantity: params.quantity,
      paymentMethod: METHOD_ENUM[params.paymentMethod],
      customerName: params.customerName,
      customerPhone: params.customerPhone,
      keshlessCardNumber: params.keshlessCardNumber,
      keshlessPin: params.keshlessPin,
      soldBy: params.operatorId,
      soldByType: 'reseller-operator',
      resellerId: params.resellerId,
      hubId: params.hubId,
      resellerCommissionPercent,
    });

    const status: 'completed' | 'pending' | 'failed' =
      sale.paymentStatus === PaymentStatus.COMPLETED ? 'completed'
      : sale.paymentStatus === PaymentStatus.PENDING ? 'pending'
      : 'failed';

    return {
      saleId: sale._id.toString(),
      status,
      tickets,
      ...(paymentMessage ? { message: paymentMessage } : {}),
    };
  }
}
